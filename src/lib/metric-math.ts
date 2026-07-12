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

export interface MetricInsight {
  /** vs previous bucket, % (null when undefined). */
  deltaPct: number | null;
  /** vs mean of the 4 buckets before the latest, % (null when <2 prior buckets or mean 0). */
  vsAvg4Pct: number | null;
  /** Latest sits outside mean±2σ of the rest of the series (needs ≥5 points). */
  isOutlier: boolean;
  /** All deterministic flags for display/payload: changeFlags + target flag. */
  flags: string[];
  /** CHANGE flags only (delta/avg4/outlier). Quiet mode keys off these — a
   *  target flag is persistent state and would disable quiet forever. */
  changeFlags: string[];
  /** Whether the latest move is good/bad news given the metric's direction. */
  goodness: 'good' | 'bad' | 'neutral';
  /** Goal tracking; null when no target set or direction is neutral (a neutral
   *  metric shows distance via targetPct but never judges on/off-track). */
  targetStatus: 'on_track' | 'off_track' | null;
  /** latest / target × 100; null when target is 0/absent or latest unknown. */
  targetPct: number | null;
}

/** Deterministic digest insights — the LLM only narrates these numbers. */
export function computeInsights(series: MetricPoint[], direction: MetricDirection, target?: number | null): MetricInsight {
  const { deltaPct } = computeDelta(series);
  const flags: string[] = [];

  // vs average of up to 4 buckets immediately before the latest.
  let vsAvg4Pct: number | null = null;
  if (series.length >= 3) {
    const prior = series.slice(Math.max(0, series.length - 5), series.length - 1).map((p) => p.v);
    const mean = prior.reduce((a, b) => a + b, 0) / prior.length;
    if (mean !== 0) vsAvg4Pct = ((series[series.length - 1].v - mean) / Math.abs(mean)) * 100;
  }

  // ±2σ outlier: latest vs distribution of everything before it.
  let isOutlier = false;
  if (series.length >= 5) {
    const rest = series.slice(0, -1).map((p) => p.v);
    const mean = rest.reduce((a, b) => a + b, 0) / rest.length;
    const sd = Math.sqrt(rest.reduce((a, b) => a + (b - mean) ** 2, 0) / rest.length);
    if (sd > 0) isOutlier = Math.abs(series[series.length - 1].v - mean) > 2 * sd;
  }

  if (deltaPct != null && Math.abs(deltaPct) >= 5) flags.push(`${deltaPct > 0 ? '+' : ''}${deltaPct.toFixed(1)}% vs prev`);
  if (vsAvg4Pct != null && Math.abs(vsAvg4Pct) >= 10) flags.push(`${vsAvg4Pct > 0 ? '+' : ''}${vsAvg4Pct.toFixed(1)}% vs 4-bucket avg`);
  if (isOutlier) flags.push('outlier ±2σ');

  const signal = deltaPct ?? vsAvg4Pct;
  const goodness: MetricInsight['goodness'] = direction === 'neutral' || signal == null || Math.abs(signal) < 5
    ? 'neutral'
    : (signal >= 0) === (direction === 'up_good') ? 'good' : 'bad';

  // Goal tracking. Change flags are frozen BEFORE the target flag is appended —
  // quiet mode must see only the change flags.
  const changeFlags = [...flags];
  const latest = series.length ? series[series.length - 1].v : null;
  let targetStatus: MetricInsight['targetStatus'] = null;
  let targetPct: number | null = null;
  if (target != null && Number.isFinite(target) && latest != null) {
    targetPct = target === 0 ? null : (latest / target) * 100;
    if (direction !== 'neutral') {
      const met = direction === 'up_good' ? latest >= target : latest <= target;
      targetStatus = met ? 'on_track' : 'off_track';
      if (!met) {
        const rel = latest < target ? 'below' : 'above';
        flags.push(`${rel} target${targetPct != null ? ` (${targetPct.toFixed(0)}%)` : ''}`);
      }
    }
  }
  return { deltaPct, vsAvg4Pct, isOutlier, flags, changeFlags, goodness, targetStatus, targetPct };
}

export interface DriverMover {
  /** Dimension value (slice label); null in the data buckets under '(none)'. */
  value: string;
  /** v_latest − v_prev for this slice; a new slice contributes +v_latest, a
   *  vanished one −v_prev. */
  delta: number;
  /** |delta| / Σ|delta| × 100 across all slices of this dimension — stable even
   *  when movers cancel out; null when nothing moved at all. */
  sharePct: number | null;
}

export interface DriverBreakdown {
  dimension: string;
  movers: DriverMover[];
}

/** Top movers for one dimension from driver rows (time, value, dim).
 *  Buckets are keyed by the EXACT t labels of the main series' last two points
 *  — never re-derived from the driver rows, which may be truncated or hold
 *  extra buckets. */
export function computeDrivers(rows: unknown[][], dimension: string, latestT: string, prevT: string, topN = 2): DriverBreakdown {
  const prev = new Map<string, number>();
  const latest = new Map<string, number>();
  for (const r of rows) {
    if (!r || r.length < 3) continue;
    const t = r[0] == null ? '' : String(r[0]);
    const v = Number(r[1]);
    if (Number.isNaN(v)) continue;
    const slice = r[2] == null ? '(none)' : String(r[2]);
    if (t === latestT) latest.set(slice, (latest.get(slice) ?? 0) + v);
    else if (t === prevT) prev.set(slice, (prev.get(slice) ?? 0) + v);
  }
  const slices = new Set([...prev.keys(), ...latest.keys()]);
  const deltas: { value: string; delta: number }[] = [];
  for (const s of slices) {
    deltas.push({ value: s, delta: (latest.get(s) ?? 0) - (prev.get(s) ?? 0) });
  }
  const totalAbs = deltas.reduce((a, d) => a + Math.abs(d.delta), 0);
  deltas.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
  return {
    dimension,
    movers: deltas.slice(0, topN).map((d) => ({
      value: d.value,
      delta: d.delta,
      sharePct: totalAbs === 0 ? null : (Math.abs(d.delta) / totalAbs) * 100,
    })),
  };
}

export interface DigestMetricLine {
  name: string;
  latest: number | null;
  insight: MetricInsight;
}

/** Numbers-only digest markdown — the LLM-failure fallback AND the source of
 *  truth the LLM narrative is checked against (it never sees other numbers). */
export function renderDigestFallback(lines: DigestMetricLine[]): string {
  const rows = lines.map((l) => {
    const d = l.insight.deltaPct;
    const badge = l.insight.goodness === 'good' ? '🟢' : l.insight.goodness === 'bad' ? '🔴' : '⚪';
    return `- ${badge} **${l.name}**: ${formatMetricValue(l.latest)}${d != null ? ` (${d > 0 ? '+' : ''}${d.toFixed(1)}% vs prev)` : ''}${l.insight.flags.length ? ` — ${l.insight.flags.join(', ')}` : ''}`;
  });
  return `## Metrics digest\n\n${rows.join('\n')}`;
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
