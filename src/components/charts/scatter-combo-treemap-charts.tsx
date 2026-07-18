'use client';

import {
  ScatterChart, Scatter, ComposedChart, Bar, Line, Treemap,
  XAxis, YAxis, ZAxis, Tooltip, Legend, ResponsiveContainer, Cell,
} from 'recharts';
import type { ChartSpec } from '../../services/chart-spec-service';

const COLORS = ['#2563eb', '#16a34a', '#d97706', '#dc2626', '#7c3aed', '#0891b2', '#db2777', '#65a30d', '#0d9488', '#9333ea', '#ca8a04', '#475569'];

/** onDatumClick carries the RAW cell value (not the String()-formatted label) so
 *  a consumer (dashboard cross-filter) can build a correct SQL literal. */
type DatumClick = (column: string, rawValue: unknown) => void;

/** Scatter of two numeric columns; optional `series` colours the points. */
export function ScatterChartView({ columns, rows, spec, onDatumClick }: {
  columns: string[]; rows: unknown[][]; spec: ChartSpec; onDatumClick?: DatumClick;
}) {
  const xi = columns.indexOf(spec.x);
  const yi = columns.indexOf(spec.y);
  if (xi === -1 || yi === -1) return null;
  const si = spec.series ? columns.indexOf(spec.series) : -1;

  const groups = new Map<string, { x: number; y: number; raw: unknown }[]>();
  for (const r of rows.slice(0, 500)) {
    const x = Number(r[xi]); const y = Number(r[yi]);
    if (Number.isNaN(x) || Number.isNaN(y)) continue;
    const key = si === -1 ? '' : String(r[si]);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push({ x, y, raw: r[xi] });
  }

  return (
    <div className="mt-2" data-testid="scatter-chart">
      <ResponsiveContainer width="100%" height={240}>
        <ScatterChart>
          <XAxis type="number" dataKey="x" name={spec.x} tick={{ fontSize: 10 }} />
          <YAxis type="number" dataKey="y" name={spec.y} tick={{ fontSize: 10 }} />
          <ZAxis range={[40, 40]} />
          <Tooltip cursor={{ strokeDasharray: '3 3' }} />
          {si !== -1 && <Legend wrapperStyle={{ fontSize: 10 }} />}
          {[...groups.entries()].map(([key, pts], i) => (
            <Scatter key={key || 'all'} name={key || spec.y} data={pts} fill={COLORS[i % COLORS.length]}
              onClick={(p: { x?: number; y?: number; raw?: unknown }) => onDatumClick?.(spec.x, p?.raw)} />
          ))}
        </ScatterChart>
      </ResponsiveContainer>
    </div>
  );
}

/** Combo: bar on y (left axis) + line on y2 (right axis). Needs an explicit right
 *  YAxis — recharts 3.x does not synthesize one. Missing y2 → degrades to bar. */
export function ComboChartView({ columns, rows, spec }: { columns: string[]; rows: unknown[][]; spec: ChartSpec }) {
  const xi = columns.indexOf(spec.x);
  const yi = columns.indexOf(spec.y);
  const y2i = spec.y2 ? columns.indexOf(spec.y2) : -1;
  if (xi === -1 || yi === -1) return null;
  const data = rows.slice(0, 200).map((r) => ({
    x: String(r[xi]), y: Number(r[yi]), ...(y2i !== -1 ? { y2: Number(r[y2i]) } : {}),
  }));
  return (
    <div className="mt-2" data-testid="combo-chart">
      <ResponsiveContainer width="100%" height={240}>
        <ComposedChart data={data}>
          <XAxis dataKey="x" tick={{ fontSize: 10 }} />
          <YAxis yAxisId="left" tick={{ fontSize: 10 }} />
          {y2i !== -1 && <YAxis yAxisId="right" orientation="right" tick={{ fontSize: 10 }} />}
          <Tooltip /><Legend wrapperStyle={{ fontSize: 10 }} />
          <Bar yAxisId="left" dataKey="y" name={spec.y} fill={COLORS[0]} />
          {y2i !== -1 && <Line yAxisId="right" dataKey="y2" name={spec.y2} stroke={COLORS[3]} dot={false} />}
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}

/** Treemap: rectangle area = |y|, one tile per x. Good for part-of-whole with
 *  many categories where a pie would be unreadable. */
export function TreemapChartView({ columns, rows, spec }: { columns: string[]; rows: unknown[][]; spec: ChartSpec }) {
  const xi = columns.indexOf(spec.x);
  const yi = columns.indexOf(spec.y);
  if (xi === -1 || yi === -1) return null;
  const data = rows.slice(0, 200)
    .map((r) => ({ name: String(r[xi]), size: Math.abs(Number(r[yi])) }))
    .filter((d) => !Number.isNaN(d.size) && d.size > 0);
  if (!data.length) return null;
  return (
    <div className="mt-2" data-testid="treemap-chart">
      <ResponsiveContainer width="100%" height={240}>
        <Treemap data={data} dataKey="size" nameKey="name" stroke="#fff">
          {data.map((_, i) => <Cell key={i} fill={COLORS[i % COLORS.length]} />)}
        </Treemap>
      </ResponsiveContainer>
    </div>
  );
}
