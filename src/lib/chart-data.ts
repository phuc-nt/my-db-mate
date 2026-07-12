/** Pure pivot helper for stacked/multi-series charts: long rows (x, series, y)
 *  → wide Recharts data. No DB imports. */

export interface PivotResult {
  /** One object per distinct x, insertion-ordered: { x, [seriesKey]: number }. */
  data: Record<string, unknown>[];
  /** Series keys ordered by total desc, capped — smaller ones merge into 'Other'. */
  seriesKeys: string[];
}

export const SERIES_CAP = 12;

/** Pivot (x, series, y) long rows to wide format. Non-numeric y coerces to 0;
 *  null/undefined series buckets under '(none)'. Beyond `cap` distinct series
 *  (by total |y|), the tail is merged into 'Other' to keep legend/colors sane. */
export function pivotLongToWide(rows: unknown[][], xi: number, si: number, yi: number, cap = SERIES_CAP): PivotResult {
  const totals = new Map<string, number>();
  for (const r of rows) {
    const s = r[si] == null ? '(none)' : String(r[si]);
    const v = Number(r[yi]);
    totals.set(s, (totals.get(s) ?? 0) + (Number.isNaN(v) ? 0 : Math.abs(v)));
  }
  const ranked = [...totals.entries()].sort((a, b) => b[1] - a[1]).map(([k]) => k);
  const kept = new Set(ranked.slice(0, cap));
  const hasOther = ranked.length > cap;

  const byX = new Map<string, Record<string, unknown>>();
  for (const r of rows) {
    const x = r[xi] == null ? '' : String(r[xi]);
    const sRaw = r[si] == null ? '(none)' : String(r[si]);
    const s = kept.has(sRaw) ? sRaw : 'Other';
    const v = Number(r[yi]);
    if (!byX.has(x)) byX.set(x, { x });
    const row = byX.get(x)!;
    row[s] = (Number(row[s]) || 0) + (Number.isNaN(v) ? 0 : v);
  }
  return {
    data: [...byX.values()],
    seriesKeys: [...ranked.slice(0, cap), ...(hasOther ? ['Other'] : [])],
  };
}
