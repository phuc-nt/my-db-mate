'use client';

import { useState } from 'react';
import {
  BarChart, Bar, LineChart, Line, AreaChart, Area, PieChart, Pie, Cell,
  XAxis, YAxis, Tooltip, Legend, ResponsiveContainer,
} from 'recharts';
import { inferChartSpec, type ChartSpec } from '../services/chart-spec-service';
import { pivotLongToWide } from '../lib/chart-data';
import { formatMetricValue } from '../lib/metric-math';
import { ScatterChartView, ComboChartView, TreemapChartView } from './charts/scatter-combo-treemap-charts';
import { HeatmapMatrixChart } from './charts/heatmap-matrix-chart';

const COLORS = ['#2563eb', '#16a34a', '#d97706', '#dc2626', '#7c3aed', '#0891b2', '#db2777', '#65a30d', '#0d9488', '#9333ea', '#ca8a04', '#475569'];

/** onDatumClick carries the RAW value (not the display label) so a consumer can
 *  build a correct SQL literal. No-op by default. */
type DatumClick = (column: string, rawValue: unknown) => void;

/**
 * Renders a result set as a chart. `spec` (persisted picker choice) wins over
 * inference; absent/invalid columns fall back to the inferred default so old
 * widgets and ad-hoc results keep working. kpi/stacked/scatter/combo/heatmap/
 * treemap are picker-only types layered on top of the basic four.
 */
export function ResultChart({ columns, rows, spec: specProp, onDatumClick }: {
  columns: string[]; rows: unknown[][]; spec?: ChartSpec | null; onDatumClick?: DatumClick;
}) {
  const inferred = inferChartSpec(columns ?? [], rows ?? []);
  const initial = specProp ?? inferred;
  const [spec, setSpec] = useState<ChartSpec | null>(initial);
  // A parent may swap the persisted spec (picker save) after mount — adjust
  // during render (React's recommended alternative to a setState-in-effect).
  const [prevProp, setPrevProp] = useState(specProp);
  if (specProp !== prevProp) {
    setPrevProp(specProp);
    if (specProp) setSpec(specProp);
  }
  if (!initial || !spec) return null;

  const xi = columns.indexOf(spec.x);
  const yi = columns.indexOf(spec.y);
  if (xi === -1 || yi === -1) {
    // Stored spec no longer matches the columns — fall back to inference.
    if (!inferred) return null;
    return <BasicChart columns={columns} rows={rows} spec={inferred} onType={(t) => setSpec({ ...inferred, type: t })} onDatumClick={onDatumClick} />;
  }

  if (spec.type === 'kpi') {
    // Big-number tile from the LAST row of the y column; delta only from the
    // result itself (last vs second-to-last) — no external metric link.
    const last = rows.length ? Number(rows[rows.length - 1][yi]) : NaN;
    const prev = rows.length >= 2 ? Number(rows[rows.length - 2][yi]) : NaN;
    const deltaPct = !Number.isNaN(last) && !Number.isNaN(prev) && prev !== 0 ? ((last - prev) / Math.abs(prev)) * 100 : null;
    return (
      <div className="py-4 text-center" data-testid="kpi-tile">
        <div className="text-4xl font-semibold">{Number.isNaN(last) ? '—' : formatMetricValue(last)}</div>
        <div className="mt-1 text-xs text-neutral-500">
          {spec.y}
          {deltaPct != null && (
            <span className={`ml-2 rounded px-1.5 py-0.5 ${deltaPct >= 0 ? 'bg-green-100 text-green-700 dark:bg-green-950/50 dark:text-green-400' : 'bg-red-100 text-red-700 dark:bg-red-950/50 dark:text-red-400'}`}>
              {deltaPct >= 0 ? '▲' : '▼'} {Math.abs(deltaPct).toFixed(1)}%
            </span>
          )}
        </div>
      </div>
    );
  }

  if (spec.type === 'scatter') return <ScatterChartView columns={columns} rows={rows} spec={spec} onDatumClick={onDatumClick} />;
  if (spec.type === 'combo') return <ComboChartView columns={columns} rows={rows} spec={spec} />;
  if (spec.type === 'treemap') return <TreemapChartView columns={columns} rows={rows} spec={spec} />;
  if (spec.type === 'heatmap') return <HeatmapMatrixChart columns={columns} rows={rows} spec={spec} onDatumClick={onDatumClick} />;

  const si = spec.series ? columns.indexOf(spec.series) : -1;
  if ((spec.type === 'stacked-bar' || spec.type === 'stacked-100' || (spec.type === 'line' && si !== -1)) && si !== -1) {
    const { data, seriesKeys } = pivotLongToWide(rows.slice(0, 500), xi, si, yi);
    const stacked = spec.type === 'stacked-bar' || spec.type === 'stacked-100';
    return (
      <div className="mt-2" data-testid={spec.type === 'stacked-100' ? 'stacked-100-chart' : spec.type === 'stacked-bar' ? 'stacked-bar-chart' : 'multi-series-line'}>
        <ResponsiveContainer width="100%" height={240}>
          {stacked ? (
            <BarChart data={data} stackOffset={spec.type === 'stacked-100' ? 'expand' : 'none'}>
              <XAxis dataKey="x" tick={{ fontSize: 10 }} />
              <YAxis tick={{ fontSize: 10 }} tickFormatter={spec.type === 'stacked-100' ? (v) => `${Math.round(v * 100)}%` : undefined} />
              <Tooltip /><Legend wrapperStyle={{ fontSize: 10 }} />
              {seriesKeys.map((k, i) => <Bar key={k} dataKey={k} stackId="a" fill={COLORS[i % COLORS.length]} />)}
            </BarChart>
          ) : (
            <LineChart data={data}>
              <XAxis dataKey="x" tick={{ fontSize: 10 }} /><YAxis tick={{ fontSize: 10 }} /><Tooltip /><Legend wrapperStyle={{ fontSize: 10 }} />
              {seriesKeys.map((k, i) => <Line key={k} dataKey={k} stroke={COLORS[i % COLORS.length]} dot={false} />)}
            </LineChart>
          )}
        </ResponsiveContainer>
      </div>
    );
  }
  // stacked without a series column degrades to a plain bar.
  if (spec.type === 'stacked-bar' || spec.type === 'stacked-100') {
    return <BasicChart columns={columns} rows={rows} spec={{ ...spec, type: 'bar' }} onType={(t) => setSpec({ ...spec, type: t, series: undefined })} onDatumClick={onDatumClick} />;
  }
  // Only the basic four reach here; any unknown type falls through to the table
  // (return null) rather than silently rendering a misleading pie.
  if (spec.type !== 'bar' && spec.type !== 'line' && spec.type !== 'area' && spec.type !== 'pie') return null;
  return <BasicChart columns={columns} rows={rows} spec={spec} onType={(t) => setSpec({ ...spec, type: t, series: undefined })} onDatumClick={onDatumClick} />;
}

/** The original four single-series types with the inline type switcher. */
function BasicChart({ columns, rows, spec, onType, onDatumClick }: {
  columns: string[]; rows: unknown[][];
  spec: ChartSpec;
  onType: (t: 'bar' | 'line' | 'area' | 'pie') => void;
  onDatumClick?: DatumClick;
}) {
  const xi = columns.indexOf(spec.x);
  const yi = columns.indexOf(spec.y);
  // rawX keeps the un-stringified x value so onDatumClick can emit a SQL literal.
  const data = rows.slice(0, 50).map((r) => ({ x: String(r[xi]), y: Number(r[yi]), rawX: r[xi] }));
  // recharts click payloads vary by chart; the datum lands on `.payload` (bar) or
  // directly (pie sector). Read rawX from either shape without fighting the types.
  const clickBar = onDatumClick
    ? (d: unknown) => {
        const payload = (d as { payload?: { rawX?: unknown }; rawX?: unknown });
        onDatumClick(spec.x, payload?.payload?.rawX ?? payload?.rawX);
      }
    : undefined;

  return (
    <div className="mt-2">
      <div className="mb-1 flex gap-1 text-xs">
        {(['bar', 'line', 'area', 'pie'] as const).map((t) => (
          <button key={t} onClick={() => onType(t)}
            className={`rounded border px-2 py-0.5 ${spec.type === t ? 'bg-blue-600 text-white' : ''}`}>{t}</button>
        ))}
      </div>
      <ResponsiveContainer width="100%" height={220}>
        {spec.type === 'bar' ? (
          <BarChart data={data}><XAxis dataKey="x" tick={{ fontSize: 10 }} /><YAxis tick={{ fontSize: 10 }} /><Tooltip /><Bar dataKey="y" fill={COLORS[0]} onClick={clickBar} /></BarChart>
        ) : spec.type === 'line' ? (
          <LineChart data={data}><XAxis dataKey="x" tick={{ fontSize: 10 }} /><YAxis tick={{ fontSize: 10 }} /><Tooltip /><Line dataKey="y" stroke={COLORS[0]} /></LineChart>
        ) : spec.type === 'area' ? (
          <AreaChart data={data}><XAxis dataKey="x" tick={{ fontSize: 10 }} /><YAxis tick={{ fontSize: 10 }} /><Tooltip /><Area dataKey="y" fill={COLORS[0]} stroke={COLORS[0]} /></AreaChart>
        ) : (
          <PieChart><Pie data={data} dataKey="y" nameKey="x" outerRadius={80} onClick={clickBar}>{data.map((_, i) => <Cell key={i} fill={COLORS[i % COLORS.length]} />)}</Pie><Tooltip /></PieChart>
        )}
      </ResponsiveContainer>
    </div>
  );
}
