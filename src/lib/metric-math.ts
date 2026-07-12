/** Pure metric math: series parsing, delta computation, grain guessing.
 *  No DB imports — keeps this unit-testable without DATABASE_URL. */

export interface MetricPoint {
  /** Time bucket label as returned by the query (ISO-ish string). */
  t: string;
  v: number;
}

export type TimeGrain = 'day' | 'week' | 'month';
export type MetricDirection = 'up_good' | 'down_good' | 'neutral';

/** Parse a (time, value) result set into a chronologically sorted series.
 *  Rows with an unparsable time or non-numeric value are dropped. */
export function parseSeries(rows: unknown[][]): MetricPoint[] {
  const pts: (MetricPoint & { ms: number })[] = [];
  for (const r of rows) {
    if (!r || r.length < 2) continue;
    const t = r[0] == null ? '' : String(r[0]);
    const ms = Date.parse(t);
    const v = r[1] == null ? NaN : Number(r[1]);
    if (Number.isNaN(ms) || Number.isNaN(v)) continue;
    pts.push({ t, v, ms });
  }
  pts.sort((a, b) => a.ms - b.ms);
  return pts.map(({ t, v }) => ({ t, v }));
}

/** Latest value vs the previous bucket. deltaPct is null when there is no
 *  previous point or the previous value is 0 (a percentage would be meaningless). */
export function computeDelta(series: MetricPoint[]): { latest: number | null; prev: number | null; deltaPct: number | null } {
  if (series.length === 0) return { latest: null, prev: null, deltaPct: null };
  const latest = series[series.length - 1].v;
  if (series.length === 1) return { latest, prev: null, deltaPct: null };
  const prev = series[series.length - 2].v;
  const deltaPct = prev === 0 ? null : ((latest - prev) / Math.abs(prev)) * 100;
  return { latest, prev, deltaPct };
}

/** Guess the bucket grain from median gap between consecutive time buckets. */
export function guessGrain(rows: unknown[][]): TimeGrain {
  const series = parseSeries(rows);
  if (series.length < 2) return 'month';
  const gaps: number[] = [];
  for (let i = 1; i < series.length; i++) {
    gaps.push(Date.parse(series[i].t) - Date.parse(series[i - 1].t));
  }
  gaps.sort((a, b) => a - b);
  const medianDays = gaps[Math.floor(gaps.length / 2)] / 86_400_000;
  if (medianDays <= 2) return 'day';
  if (medianDays <= 10) return 'week';
  return 'month';
}

/** Shape gate for metric SQL results: exactly 2 columns, col 1 date-parsable and
 *  col 2 numeric on ≥80% of rows. Returns a user-facing reason on failure. */
export function validateMetricShape(columns: string[], rows: unknown[][]): { ok: true } | { ok: false; reason: string } {
  if (columns.length !== 2) {
    return { ok: false, reason: `Metric SQL must return exactly 2 columns (time_bucket, value) — got ${columns.length}` };
  }
  if (rows.length === 0) return { ok: false, reason: 'Metric SQL returned no rows — need at least one time bucket' };
  let timeOk = 0;
  let numOk = 0;
  for (const r of rows) {
    if (r[0] != null && !Number.isNaN(Date.parse(String(r[0])))) timeOk++;
    if (r[1] != null && !Number.isNaN(Number(r[1]))) numOk++;
  }
  if (timeOk / rows.length < 0.8) {
    return { ok: false, reason: `First column "${columns[0]}" must be a date/time bucket (parsable on ≥80% of rows)` };
  }
  if (numOk / rows.length < 0.8) {
    return { ok: false, reason: `Second column "${columns[1]}" must be numeric (on ≥80% of rows)` };
  }
  return { ok: true };
}

/** Compact display for card values: 1234567 → "1.23M". */
export function formatMetricValue(v: number | null): string {
  if (v == null) return '—';
  const abs = Math.abs(v);
  if (abs >= 1_000_000_000) return `${(v / 1_000_000_000).toFixed(2)}B`;
  if (abs >= 1_000_000) return `${(v / 1_000_000).toFixed(2)}M`;
  if (abs >= 10_000) return `${(v / 1_000).toFixed(1)}K`;
  return Number.isInteger(v) ? String(v) : v.toFixed(2);
}
