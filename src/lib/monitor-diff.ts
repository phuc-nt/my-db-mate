/** Pure snapshot-diff logic for the data-drift monitor — separated from the
 *  service so unit tests never pull in the db client (vitest has no DATABASE_URL). */
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

