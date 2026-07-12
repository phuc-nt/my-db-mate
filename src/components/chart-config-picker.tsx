'use client';

import { useState } from 'react';
import type { ChartSpec } from '../services/chart-spec-service';

const TYPES: { value: ChartSpec['type']; label: string; needsSeries?: boolean }[] = [
  { value: 'bar', label: 'Bar' },
  { value: 'line', label: 'Line' },
  { value: 'area', label: 'Area' },
  { value: 'pie', label: 'Pie' },
  { value: 'kpi', label: 'KPI tile' },
  { value: 'stacked-bar', label: 'Stacked bar', needsSeries: true },
];

/** Shared chart-config picker: type + x + y (+ optional series for stacked /
 *  multi-series long-format data). Parent owns persistence (widget PATCH) or
 *  session state (result table). */
export function ChartConfigPicker({ columns, value, onApply }: {
  columns: string[];
  value?: ChartSpec | null;
  onApply: (spec: ChartSpec) => void;
}) {
  const [type, setType] = useState<ChartSpec['type']>(value?.type ?? 'bar');
  const [x, setX] = useState(value?.x ?? columns[0] ?? '');
  const [y, setY] = useState(value?.y ?? columns[1] ?? columns[0] ?? '');
  const [series, setSeries] = useState(value?.series ?? '');

  const sel = 'rounded border p-1 text-xs dark:bg-neutral-900';
  return (
    <div className="flex flex-wrap items-center gap-1.5 text-xs" data-testid="chart-config-picker">
      <select className={sel} value={type} onChange={(e) => setType(e.target.value as ChartSpec['type'])} data-testid="picker-type">
        {TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
      </select>
      <label>x <select className={sel} value={x} onChange={(e) => setX(e.target.value)} data-testid="picker-x">
        {columns.map((c) => <option key={c}>{c}</option>)}
      </select></label>
      <label>y <select className={sel} value={y} onChange={(e) => setY(e.target.value)} data-testid="picker-y">
        {columns.map((c) => <option key={c}>{c}</option>)}
      </select></label>
      <label>series <select className={sel} value={series} onChange={(e) => setSeries(e.target.value)} data-testid="picker-series">
        <option value="">—</option>
        {columns.map((c) => <option key={c}>{c}</option>)}
      </select></label>
      <button onClick={() => onApply({ type, x, y, ...(series ? { series } : {}) })}
        className="rounded bg-blue-600 px-2 py-0.5 text-white" data-testid="picker-apply">Apply</button>
    </div>
  );
}
