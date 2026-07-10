/**
 * Client-side pivot / group-by over an already-loaded result set (the rows the
 * chat fetched, capped at the safety LIMIT). Pure — no SQL, no DB. Used to
 * regroup a table without asking the agent to rewrite the query.
 *
 * Scope: one group column × one value column × one aggregate. For the full table
 * (beyond the loaded rows) the user should ask the agent to GROUP BY.
 */
export type PivotAgg = 'count' | 'sum' | 'avg' | 'min' | 'max';

export interface PivotResult {
  columns: string[];
  rows: unknown[][];
}

const NULL_KEY = '(null)';

/** Coerce a cell to a finite number, or null. Handles thousands separators and a
 *  leading currency symbol so a pasted-looking '$1,234' still counts. */
function toNumber(v: unknown): number | null {
  if (v == null) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'bigint') return Number(v);
  if (typeof v === 'boolean') return v ? 1 : 0;
  const s = String(v).trim().replace(/^[$€£¥]/, '').replace(/,/g, '');
  if (s === '') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/**
 * Pivot `rows` (aligned to `columns`) by `groupCol`, aggregating `valueCol`.
 * `count` ignores `valueCol` (counts rows per group). sum/avg/min/max coerce the
 * value to a number and skip non-numeric/null cells; avg over zero valid values
 * is null (not NaN). Groups are returned sorted by the aggregate, descending.
 */
export function pivot(
  columns: string[],
  rows: unknown[][],
  groupCol: string,
  valueCol: string | null,
  agg: PivotAgg,
): PivotResult {
  const gi = columns.indexOf(groupCol);
  const vi = valueCol ? columns.indexOf(valueCol) : -1;
  if (gi < 0) return { columns, rows };

  // Preserve first-seen group order for stable ties, aggregate per group.
  const order: string[] = [];
  const groups = new Map<string, { count: number; nums: number[] }>();
  for (const r of rows) {
    const gv = r[gi];
    const key = gv == null ? NULL_KEY : String(gv);
    let g = groups.get(key);
    if (!g) { g = { count: 0, nums: [] }; groups.set(key, g); order.push(key); }
    g.count++;
    if (vi >= 0) { const n = toNumber(r[vi]); if (n != null) g.nums.push(n); }
  }

  const aggValue = (g: { count: number; nums: number[] }): number | null => {
    if (agg === 'count') return g.count;
    if (g.nums.length === 0) return null; // no numeric values → null, never NaN
    switch (agg) {
      case 'sum': return g.nums.reduce((a, b) => a + b, 0);
      case 'avg': return g.nums.reduce((a, b) => a + b, 0) / g.nums.length;
      case 'min': return Math.min(...g.nums);
      case 'max': return Math.max(...g.nums);
    }
  };

  const outCol = agg === 'count' ? 'count' : `${agg}(${valueCol})`;
  const outRows: unknown[][] = order.map((key) => [key, aggValue(groups.get(key)!)]);
  // Sort by aggregate descending; nulls last.
  outRows.sort((a, b) => {
    const av = a[1] as number | null, bv = b[1] as number | null;
    if (av == null) return bv == null ? 0 : 1;
    if (bv == null) return -1;
    return bv - av;
  });
  return { columns: [groupCol, outCol], rows: outRows };
}
