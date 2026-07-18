/** Chart spec inferred from a result set — validated with zod, falls back to none. */
import { z } from 'zod';

export const ChartSpecSchema = z.object({
  // kpi + stacked-bar + the five below are picker-only (never auto-inferred);
  // old {type,x,y} and {type,x,y,series} specs parse unchanged — every field
  // past x/y is optional, so growing this enum is a zero-migration change.
  type: z.enum([
    'bar', 'line', 'area', 'pie', 'kpi', 'stacked-bar',
    'scatter', 'combo', 'stacked-100', 'heatmap', 'treemap',
  ]),
  x: z.string(),
  y: z.string(),
  /** Grouping column for stacked-bar / multi-series line / heatmap / scatter color (long-format data). */
  series: z.string().optional(),
  /** Second measure for combo: bar = y (left axis), line = y2 (right axis). */
  y2: z.string().optional(),
});
export type ChartSpec = z.infer<typeof ChartSpecSchema>;

/**
 * Heuristic default chart from columns + a small sample. Deterministic (no LLM):
 * two columns where one is categorical/temporal and one numeric → bar/line.
 * The agent can also propose a spec; validate it with ChartSpecSchema.
 */
export function inferChartSpec(columns: string[], rows: unknown[][]): ChartSpec | null {
  if (columns.length < 2 || rows.length === 0) return null;
  const isNumeric = (i: number) => rows.every((r) => r[i] == null || !isNaN(Number(r[i])));
  const numericCol = columns.findIndex((_, i) => isNumeric(i));
  if (numericCol === -1) return null;
  const looksTemporal = (name: string) => /date|time|month|year|day|week|quarter|created|_at$/i.test(name);

  // A non-numeric column is the natural label; prefer it (bar/line as before).
  const labelCol = columns.findIndex((_, i) => i !== numericCol && !isNumeric(i));
  if (labelCol !== -1) {
    return { type: looksTemporal(columns[labelCol]) ? 'line' : 'bar', x: columns[labelCol], y: columns[numericCol] };
  }
  // No categorical/temporal label but a second numeric column exists → scatter
  // (added after the label cases so existing behaviour is unchanged).
  const secondNumeric = columns.findIndex((_, i) => i !== numericCol && isNumeric(i));
  if (secondNumeric !== -1 && !looksTemporal(columns[numericCol]) && !looksTemporal(columns[secondNumeric])) {
    return { type: 'scatter', x: columns[numericCol], y: columns[secondNumeric] };
  }
  // Fall back to the old any-other-column-as-label behaviour.
  const anyLabel = columns.findIndex((_, i) => i !== numericCol);
  if (anyLabel === -1) return null;
  return { type: looksTemporal(columns[anyLabel]) ? 'line' : 'bar', x: columns[anyLabel], y: columns[numericCol] };
}

export function validateChartSpec(spec: unknown): ChartSpec | null {
  const r = ChartSpecSchema.safeParse(spec);
  return r.success ? r.data : null;
}

/** Conservative auto-open rule for the result view (stricter than inferChartSpec,
 *  which is a "best chart IF the user asks" heuristic):
 *  - temporal label + numeric → line (any row count — time series read better as lines)
 *  - exactly 2 columns, categorical + numeric, ≤20 rows → bar
 *  - anything else → null (table stays the default)
 *  User toggles always win; this only picks the INITIAL view. */
export function shouldAutoChart(columns: string[], rows: unknown[][]): ChartSpec | null {
  const spec = inferChartSpec(columns, rows);
  if (!spec) return null;
  // Auto-open stays conservative: only line/bar (the same two it ever produced
  // here). Scatter is inferrable now but must NEVER auto-open — it would also
  // change the "Track as metric" gate, which keys on an auto-charted line.
  if (spec.type !== 'line' && spec.type !== 'bar') return null;
  if (spec.type === 'line') return spec;                 // temporal — always chart-worthy
  if (columns.length === 2 && rows.length > 0 && rows.length <= 20) return spec; // small categorical
  return null;
}
