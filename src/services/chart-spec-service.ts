/** Chart spec inferred from a result set — validated with zod, falls back to none. */
import { z } from 'zod';

export const ChartSpecSchema = z.object({
  type: z.enum(['bar', 'line', 'area', 'pie']),
  x: z.string(),
  y: z.string(),
});
export type ChartSpec = z.infer<typeof ChartSpecSchema>;

/**
 * Heuristic default chart from columns + a small sample. Deterministic (no LLM):
 * two columns where one is categorical/temporal and one numeric → bar/line.
 * The agent can also propose a spec; validate it with ChartSpecSchema.
 */
export function inferChartSpec(columns: string[], rows: unknown[][]): ChartSpec | null {
  if (columns.length < 2 || rows.length === 0) return null;
  const numericCol = columns.findIndex((_, i) => rows.every((r) => r[i] == null || !isNaN(Number(r[i]))));
  if (numericCol === -1) return null;
  const labelCol = columns.findIndex((_, i) => i !== numericCol);
  if (labelCol === -1) return null;
  const looksTemporal = /date|time|month|year|day|created|_at$/i.test(columns[labelCol]);
  return { type: looksTemporal ? 'line' : 'bar', x: columns[labelCol], y: columns[numericCol] };
}

export function validateChartSpec(spec: unknown): ChartSpec | null {
  const r = ChartSpecSchema.safeParse(spec);
  return r.success ? r.data : null;
}
