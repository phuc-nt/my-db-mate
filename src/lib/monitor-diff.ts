/** Pure snapshot-diff logic for the data-drift monitor — separated from the
 *  service so unit tests never pull in the db client (vitest has no DATABASE_URL). */
import { madOutlier, MIN_MAD_OBS } from './robust-stats';
export interface MonitorThresholds {
  rowCountPct: number;   // alert when |Δ| exceeds this % AND the absolute floor
  rowCountAbsMin: number; // ignore diffs smaller than this many rows (small tables)
  nullRatePoints: number; // alert when nullRate rises more than this many points (0-1 scale)
  avgPct: number;         // alert when avg shifts more than this %
}

export const DEFAULT_THRESHOLDS: MonitorThresholds = {
  rowCountPct: 30,
  rowCountAbsMin: 20,
  nullRatePoints: 0.10,
  avgPct: 50,
};

export interface MonitorFinding {
  table: string;
  metric: string; // 'rowCount' | 'nullRate:<col>' | 'avg:<col>'
  before: number;
  after: number;
  deltaPct: number | null;
  /** How the finding was judged: 'threshold' = the legacy vs-previous rule (also the
   *  cold-start path); 'baseline' = robust MAD vs the rolling history baseline. Additive
   *  field — existing consumers that ignore it are unaffected. */
  method?: 'threshold' | 'baseline';
  /** Number of historical observations the baseline used (baseline method only). */
  baselineN?: number;
}

export type Snapshot = { rowCount: number; columns: Record<string, { nullRate: number; avg: number | null }> };

/** Pure diff — unit-tested. Returns findings past thresholds; empty = healthy. */
export function diffSnapshots(table: string, prev: Snapshot, cur: Snapshot, t: MonitorThresholds = DEFAULT_THRESHOLDS): MonitorFinding[] {
  const out: MonitorFinding[] = [];
  const dRows = cur.rowCount - prev.rowCount;
  if (Math.abs(dRows) >= t.rowCountAbsMin && prev.rowCount > 0 && Math.abs(dRows) / prev.rowCount * 100 > t.rowCountPct) {
    out.push({ table, metric: 'rowCount', before: prev.rowCount, after: cur.rowCount, deltaPct: Math.round(dRows / prev.rowCount * 1000) / 10 });
  }
  for (const [col, curM] of Object.entries(cur.columns)) {
    const prevM = prev.columns[col];
    if (!prevM) continue;
    if (curM.nullRate - prevM.nullRate > t.nullRatePoints) {
      out.push({ table, metric: `nullRate:${col}`, before: prevM.nullRate, after: curM.nullRate, deltaPct: null });
    }
    if (prevM.avg != null && curM.avg != null && prevM.avg !== 0) {
      const pct = Math.abs(curM.avg - prevM.avg) / Math.abs(prevM.avg) * 100;
      if (pct > t.avgPct) {
        out.push({ table, metric: `avg:${col}`, before: prevM.avg, after: curM.avg, deltaPct: Math.round((curM.avg - prevM.avg) / Math.abs(prevM.avg) * 1000) / 10 });
      }
    }
  }
  return out;
}

/** Robust drift detection vs a ROLLING BASELINE instead of only the previous snapshot.
 *  `history` is the prior snapshots (chronological, NOT including `cur`); each metric
 *  (rowCount, per-column nullRate/avg) becomes a series judged by median±k·MAD, which
 *  catches slow creep the vs-previous threshold misses and is robust to a single noisy
 *  prior. Cold-start: when history is shorter than `MIN_MAD_OBS`, fall back to the exact
 *  legacy `diffSnapshots` vs the latest prior snapshot — so early runs behave identically
 *  to today (no false-confident baseline). k defaults to 3 (MAD units). */
export function diffAgainstBaseline(
  table: string,
  history: Snapshot[],
  cur: Snapshot,
  t: MonitorThresholds = DEFAULT_THRESHOLDS,
  k = 3,
): MonitorFinding[] {
  if (history.length < MIN_MAD_OBS) {
    const prev = history[history.length - 1];
    return prev ? diffSnapshots(table, prev, cur, t) : [];
  }
  const out: MonitorFinding[] = [];
  const n = history.length;

  const rowSeries = history.map((s) => s.rowCount);
  const rowV = madOutlier(cur.rowCount, rowSeries, k);
  if (rowV.isOutlier) {
    const base = rowV.centre;
    out.push({
      table, metric: 'rowCount', before: base, after: cur.rowCount,
      deltaPct: base !== 0 ? Math.round((cur.rowCount - base) / Math.abs(base) * 1000) / 10 : null,
      method: 'baseline', baselineN: n,
    });
  }

  for (const [col, curM] of Object.entries(cur.columns)) {
    const nullSeries = history.map((s) => s.columns[col]?.nullRate).filter((v): v is number => v != null);
    if (nullSeries.length >= MIN_MAD_OBS) {
      const v = madOutlier(curM.nullRate, nullSeries, k);
      // Only flag a RISE in null rate (a drop in nulls isn't a data-quality alert).
      if (v.isOutlier && curM.nullRate > v.centre) {
        out.push({ table, metric: `nullRate:${col}`, before: v.centre, after: curM.nullRate, deltaPct: null, method: 'baseline', baselineN: nullSeries.length });
      }
    }
    const avgSeries = history.map((s) => s.columns[col]?.avg).filter((v): v is number => v != null);
    if (curM.avg != null && avgSeries.length >= MIN_MAD_OBS) {
      const v = madOutlier(curM.avg, avgSeries, k);
      if (v.isOutlier) {
        const base = v.centre;
        out.push({ table, metric: `avg:${col}`, before: base, after: curM.avg, deltaPct: base !== 0 ? Math.round((curM.avg - base) / Math.abs(base) * 1000) / 10 : null, method: 'baseline', baselineN: avgSeries.length });
      }
    }
  }
  return out;
}

