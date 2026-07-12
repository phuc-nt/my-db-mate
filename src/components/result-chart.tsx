'use client';

import { useState } from 'react';
import {
  BarChart, Bar, LineChart, Line, AreaChart, Area, PieChart, Pie, Cell,
  XAxis, YAxis, Tooltip, Legend, ResponsiveContainer,
} from 'recharts';
import { inferChartSpec, type ChartSpec } from '../services/chart-spec-service';
import { pivotLongToWide } from '../lib/chart-data';
import { formatMetricValue } from '../lib/metric-math';

const COLORS = ['#2563eb', '#16a34a', '#d97706', '#dc2626', '#7c3aed', '#0891b2', '#db2777', '#65a30d', '#0d9488', '#9333ea', '#ca8a04', '#475569'];

/**
 * Renders a result set as a chart. `spec` (persisted picker choice) wins over
 * inference; absent/invalid columns fall back to the inferred default so old
 * widgets and ad-hoc results keep working. kpi/stacked-bar/multi-series are
 * picker-only types layered on top of the basic four.
 */
export function ResultChart({ columns, rows, spec: specProp }: { columns: string[]; rows: unknown[][]; spec?: ChartSpec | null }) {
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
    return <BasicChart columns={columns} rows={rows} spec={inferred} onType={(t) => setSpec({ ...inferred, type: t })} />;
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

  const si = spec.series ? columns.indexOf(spec.series) : -1;
  if ((spec.type === 'stacked-bar' || (spec.type === 'line' && si !== -1)) && si !== -1) {
    const { data, seriesKeys } = pivotLongToWide(rows.slice(0, 500), xi, si, yi);
    return (
      <div className="mt-2" data-testid={spec.type === 'stacked-bar' ? 'stacked-bar-chart' : 'multi-series-line'}>
        <ResponsiveContainer width="100%" height={240}>
          {spec.type === 'stacked-bar' ? (
            <BarChart data={data}>
              <XAxis dataKey="x" tick={{ fontSize: 10 }} /><YAxis tick={{ fontSize: 10 }} /><Tooltip /><Legend wrapperStyle={{ fontSize: 10 }} />
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
  // stacked-bar without a series column degrades to a plain bar.
  const basic = spec.type === 'stacked-bar' ? { ...spec, type: 'bar' as const } : spec;
  return <BasicChart columns={columns} rows={rows} spec={basic} onType={(t) => setSpec({ ...spec, type: t, series: undefined })} />;
}

/** The original four single-series types with the inline type switcher. */
function BasicChart({ columns, rows, spec, onType }: {
  columns: string[]; rows: unknown[][];
  spec: ChartSpec;
  onType: (t: 'bar' | 'line' | 'area' | 'pie') => void;
}) {
  const xi = columns.indexOf(spec.x);
  const yi = columns.indexOf(spec.y);
  const data = rows.slice(0, 50).map((r) => ({ x: String(r[xi]), y: Number(r[yi]) }));

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
          <BarChart data={data}><XAxis dataKey="x" tick={{ fontSize: 10 }} /><YAxis tick={{ fontSize: 10 }} /><Tooltip /><Bar dataKey="y" fill={COLORS[0]} /></BarChart>
        ) : spec.type === 'line' ? (
          <LineChart data={data}><XAxis dataKey="x" tick={{ fontSize: 10 }} /><YAxis tick={{ fontSize: 10 }} /><Tooltip /><Line dataKey="y" stroke={COLORS[0]} /></LineChart>
        ) : spec.type === 'area' ? (
          <AreaChart data={data}><XAxis dataKey="x" tick={{ fontSize: 10 }} /><YAxis tick={{ fontSize: 10 }} /><Tooltip /><Area dataKey="y" fill={COLORS[0]} stroke={COLORS[0]} /></AreaChart>
        ) : (
          <PieChart><Pie data={data} dataKey="y" nameKey="x" outerRadius={80}>{data.map((_, i) => <Cell key={i} fill={COLORS[i % COLORS.length]} />)}</Pie><Tooltip /></PieChart>
        )}
      </ResponsiveContainer>
    </div>
  );
}
