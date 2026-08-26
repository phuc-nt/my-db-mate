/** Pure pivot helper for stacked/multi-series charts: long rows (x, series, y)
 *  → wide Recharts data. No DB imports. */

export interface PivotResult {
  /** One object per distinct x, insertion-ordered: { x, [seriesKey]: number }. */
  data: Record<string, unknown>[];
  /** Series keys ordered by total desc, capped — smaller ones merge into 'Other'. */
  seriesKeys: string[];
}

export const SERIES_CAP = 12;

/** Heatmap cap — matrices beyond this on either axis are refused (the caller
 *  shows a "refine SQL" message) rather than rendering an unreadable grid. */
export const HEATMAP_AXIS_CAP = 30;

export interface HeatmapMatrix {
  /** Distinct x values in first-seen order (NO reordering — a month axis must
   *  stay chronological, unlike pivotLongToWide which sorts by total). */
  xKeys: string[];
  /** Raw (un-stringified) x value for each xKey, same order — lets a consumer
   *  (cross-filter) build a correct SQL literal instead of the display string. */
  xRaw: Map<string, unknown>;
  /** Distinct series values in first-seen order. */
  seriesKeys: string[];
  /** cells[series][x] = numeric value, or null when that (x, series) pair has
   *  no row (rendered as an empty cell, excluded from the color scale). */
  cells: Map<string, Map<string, number | null>>;
  min: number;
  max: number;
  /** True when either axis exceeded HEATMAP_AXIS_CAP — caller should not render. */
  tooLarge: boolean;
}

/** Build a heatmap matrix from (x, series, y) long rows. First-seen ordering on
 *  both axes, missing pairs stay null (not 0 — 0 would distort the color scale),
 *  and no "Other" bucket merge. Refuses matrices past HEATMAP_AXIS_CAP. */
/** Rows are capped before building — a large result with few distinct x/series
 *  would otherwise scan every row even though the grid itself is tiny. */
export const HEATMAP_ROW_SCAN_CAP = 5000;

export function buildHeatmapMatrix(rows: unknown[][], xi: number, si: number, yi: number): HeatmapMatrix {
  const xKeys: string[] = [];
  const xRaw = new Map<string, unknown>();
  const seriesKeys: string[] = [];
  const xSeen = new Set<string>();
  const sSeen = new Set<string>();
  const cells = new Map<string, Map<string, number | null>>();
  let min = Infinity;
  let max = -Infinity;

  for (const r of rows.length > HEATMAP_ROW_SCAN_CAP ? rows.slice(0, HEATMAP_ROW_SCAN_CAP) : rows) {
    const x = r[xi] == null ? '' : String(r[xi]);
    const s = r[si] == null ? '(none)' : String(r[si]);
    if (!xSeen.has(x)) { xSeen.add(x); xKeys.push(x); xRaw.set(x, r[xi]); }
    if (!sSeen.has(s)) { sSeen.add(s); seriesKeys.push(s); }
    const v = Number(r[yi]);
    if (Number.isNaN(v)) continue;
    if (!cells.has(s)) cells.set(s, new Map());
    const row = cells.get(s)!;
    const next = (row.get(x) as number | null | undefined);
    const acc = (typeof next === 'number' ? next : 0) + v;
    row.set(x, acc);
    if (acc < min) min = acc;
    if (acc > max) max = acc;
  }

  const tooLarge = xKeys.length > HEATMAP_AXIS_CAP || seriesKeys.length > HEATMAP_AXIS_CAP;
  if (min === Infinity) { min = 0; max = 0; }
  return { xKeys, xRaw, seriesKeys, cells, min, max, tooLarge };
}

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
