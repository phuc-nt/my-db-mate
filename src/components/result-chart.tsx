'use client';

import { useState } from 'react';
import {
  BarChart, Bar, LineChart, Line, AreaChart, Area, PieChart, Pie, Cell,
  XAxis, YAxis, Tooltip, ResponsiveContainer,
} from 'recharts';
import { inferChartSpec, type ChartSpec } from '../services/chart-spec-service';

const COLORS = ['#2563eb', '#16a34a', '#d97706', '#dc2626', '#7c3aed', '#0891b2'];

/** Renders a result set as a chart when a spec can be inferred. User can switch type. */
export function ResultChart({ columns, rows }: { columns: string[]; rows: unknown[][] }) {
  const initial = inferChartSpec(columns ?? [], rows ?? []);
  const [spec, setSpec] = useState<ChartSpec | null>(initial);
  if (!initial || !spec) return null;

  const xi = columns.indexOf(spec.x);
  const yi = columns.indexOf(spec.y);
  const data = rows.slice(0, 50).map((r) => ({ x: String(r[xi]), y: Number(r[yi]) }));

  return (
    <div className="mt-2">
      <div className="mb-1 flex gap-1 text-xs">
        {(['bar', 'line', 'area', 'pie'] as const).map((t) => (
          <button key={t} onClick={() => setSpec({ ...spec, type: t })}
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
