'use client';

import { useState } from 'react';
import type { ChartSpec } from '../services/chart-spec-service';

const TYPES: { value: ChartSpec['type']; label: string; needsSeries?: boolean; needsY2?: boolean }[] = [
  { value: 'bar', label: 'Bar' },
  { value: 'line', label: 'Line' },
  { value: 'area', label: 'Area' },
  { value: 'pie', label: 'Pie' },
  { value: 'kpi', label: 'KPI tile' },
  { value: 'scatter', label: 'Scatter' },
  { value: 'combo', label: 'Combo (bar + line)', needsY2: true },
  { value: 'treemap', label: 'Treemap' },
  { value: 'stacked-bar', label: 'Stacked bar', needsSeries: true },
  { value: 'stacked-100', label: 'Stacked 100%', needsSeries: true },
  { value: 'heatmap', label: 'Heatmap', needsSeries: true },
];

/** Shared chart-config picker: type + x + y (+ optional series for stacked /
 *  multi-series / heatmap, + optional y2 for combo). Parent owns persistence
 *  (widget PATCH) or session state (result table). Switching to a type that
 *  doesn't use series/y2 clears those so a stale column can't leak into the spec. */
export function ChartConfigPicker({ columns, value, onApply }: {
  columns: string[];
  value?: ChartSpec | null;
  onApply: (spec: ChartSpec) => void;
}) {
  const [type, setType] = useState<ChartSpec['type']>(value?.type ?? 'bar');
  const [x, setX] = useState(value?.x ?? columns[0] ?? '');
  const [y, setY] = useState(value?.y ?? columns[1] ?? columns[0] ?? '');
  const [series, setSeries] = useState(value?.series ?? '');
  const [y2, setY2] = useState(value?.y2 ?? '');

  const meta = TYPES.find((t) => t.value === type);
  const showSeries = !!meta?.needsSeries;
  const showY2 = !!meta?.needsY2;

  const sel = 'rounded border p-1 text-xs dark:bg-neutral-900';
  const canApply = (!meta?.needsSeries || !!series) && (!meta?.needsY2 || !!y2);

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
      {showY2 && (
        <label>y2 <select className={sel} value={y2} onChange={(e) => setY2(e.target.value)} data-testid="picker-y2">
          <option value="">—</option>
          {columns.map((c) => <option key={c}>{c}</option>)}
        </select></label>
      )}
      {showSeries && (
        <label>series <select className={sel} value={series} onChange={(e) => setSeries(e.target.value)} data-testid="picker-series">
          <option value="">—</option>
          {columns.map((c) => <option key={c}>{c}</option>)}
        </select></label>
      )}
      <button
        disabled={!canApply}
        title={canApply ? undefined : (meta?.needsSeries ? 'This chart needs a series column' : 'This chart needs a y2 column')}
        onClick={() => onApply({ type, x, y, ...(showSeries && series ? { series } : {}), ...(showY2 && y2 ? { y2 } : {}) })}
        className="rounded bg-blue-600 px-2 py-0.5 text-white disabled:opacity-40" data-testid="picker-apply">Apply</button>
    </div>
  );
}
