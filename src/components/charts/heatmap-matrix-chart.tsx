'use client';

import type { ChartSpec } from '../../services/chart-spec-service';
import { buildHeatmapMatrix, HEATMAP_AXIS_CAP } from '../../lib/chart-data';
import { formatMetricValue } from '../../lib/metric-math';

/** onDatumClick carries the RAW x value so a consumer can build a SQL literal. */
type DatumClick = (column: string, rawValue: unknown) => void;

/** Two-dimension heatmap (x × series → colour-by-y) as a CSS grid — recharts has
 *  no native heatmap. Axes keep first-seen order; empty (x, series) pairs render
 *  blank and stay out of the colour scale. Refuses matrices past the axis cap. */
export function HeatmapMatrixChart({ columns, rows, spec, onDatumClick }: {
  columns: string[]; rows: unknown[][]; spec: ChartSpec; onDatumClick?: DatumClick;
}) {
  const xi = columns.indexOf(spec.x);
  const yi = columns.indexOf(spec.y);
  const si = spec.series ? columns.indexOf(spec.series) : -1;
  if (xi === -1 || yi === -1 || si === -1) return null;

  const m = buildHeatmapMatrix(rows, xi, si, yi);
  if (m.tooLarge) {
    return (
      <div className="mt-2 rounded border border-amber-300 bg-amber-50 p-3 text-xs text-amber-700 dark:bg-amber-950/30 dark:text-amber-400" data-testid="heatmap-too-large">
        Heatmap has too many buckets ({m.xKeys.length}×{m.seriesKeys.length}, cap {HEATMAP_AXIS_CAP}). Refine the query (fewer groups or a coarser time grain).
      </div>
    );
  }

  const span = m.max - m.min || 1;
  const color = (v: number | null) => {
    if (v == null) return undefined; // empty cell — no fill
    const t = (v - m.min) / span; // 0..1
    // light → strong blue; keep text readable at both ends
    const light = Math.round(90 - t * 55); // 90% → 35% lightness
    return `hsl(217, 91%, ${light}%)`;
  };

  return (
    <div className="mt-2 overflow-x-auto" data-testid="heatmap-chart">
      <table className="border-collapse text-[10px]">
        <thead>
          <tr>
            <th className="p-1"></th>
            {m.xKeys.map((x) => <th key={x} className="p-1 text-left font-normal text-neutral-500">{x}</th>)}
          </tr>
        </thead>
        <tbody>
          {m.seriesKeys.map((s) => (
            <tr key={s}>
              <th className="whitespace-nowrap p-1 text-right font-normal text-neutral-500">{s}</th>
              {m.xKeys.map((x) => {
                const v = m.cells.get(s)?.get(x) ?? null;
                const bg = color(v);
                return (
                  <td key={x} title={`${s} · ${x}: ${v == null ? '—' : formatMetricValue(v)}`}
                    onClick={() => onDatumClick?.(spec.x, m.xRaw.get(x))}
                    className="cursor-default border border-white p-1 text-center dark:border-neutral-900"
                    style={{ backgroundColor: bg, color: bg && (v! - m.min) / span > 0.55 ? '#fff' : undefined, minWidth: 28 }}>
                    {v == null ? '' : formatMetricValue(v)}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
