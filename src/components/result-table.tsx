'use client';

import { useMemo, useState } from 'react';
import { ResultChart } from './result-chart';
import { ChartConfigPicker } from './chart-config-picker';
import { pivot, type PivotAgg } from '../lib/pivot';
import { shouldAutoChart, type ChartSpec } from '../services/chart-spec-service';
import { CopyButton } from './copy-button';
import { toCsv, toJson, toSqlInsert, downloadText, type ExportDialect } from '../lib/export-formats';

/** Renders a SQL result set as a table with CSV/JSON/SQL export + optional chart
 *  view. Caps rendered rows for large results (server already caps via LIMIT). */
const RENDER_CAP = 200;
const SAFETY_CAP = 500; // the server-side LIMIT; a full 500-row set is likely capped

export function ResultTable({ columns, rows, dialect = 'sqlite' }: { columns: string[]; rows: unknown[][]; dialect?: ExportDialect }) {
  // Initial view only — user toggles always win afterwards (state, never re-derived).
  const [view, setView] = useState<'table' | 'chart'>(() => (shouldAutoChart(columns, rows) ? 'chart' : 'table'));
  // Pivot state: when set, the table shows the client-side regrouped result.
  const [pv, setPv] = useState<{ group: string; value: string; agg: PivotAgg } | null>(null);
  // Session-only chart config from the picker (widgets persist theirs via PATCH).
  const [chartSpec, setChartSpec] = useState<ChartSpec | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const baseRows = rows ?? [];
  const baseCols = columns ?? [];

  // The pivot runs over the FULL loaded row array (≤ safety cap), NOT the 200-row
  // render slice — regrouping a 200-row view would give wrong totals.
  const pivoted = useMemo(
    () => (pv ? pivot(baseCols, baseRows, pv.group, pv.value || null, pv.agg) : null),
    [pv, baseCols, baseRows],
  );
  const safeCols = pivoted ? pivoted.columns : baseCols;
  const safeRows = pivoted ? pivoted.rows : baseRows;
  const shown = safeRows.slice(0, RENDER_CAP);
  const truncated = safeRows.length > RENDER_CAP;

  if (baseCols.length === 0) return <p className="text-xs text-neutral-500">No columns.</p>;

  return (
    <div className="mt-1">
      <div className="mb-1 flex flex-wrap items-center gap-2 text-xs text-neutral-500">
        <span>{safeRows.length} row{safeRows.length === 1 ? '' : 's'}</span>
        <button onClick={() => downloadText(toCsv(safeCols, safeRows), 'result.csv', 'text/csv')} className="rounded border px-2 py-0.5 hover:bg-neutral-100 dark:hover:bg-neutral-800">CSV</button>
        <button onClick={() => downloadText(toJson(safeCols, safeRows), 'result.json', 'application/json')} className="rounded border px-2 py-0.5 hover:bg-neutral-100 dark:hover:bg-neutral-800">JSON</button>
        <button onClick={() => downloadText(toSqlInsert(safeCols, safeRows, dialect), 'result.sql', 'text/plain')} className="rounded border px-2 py-0.5 hover:bg-neutral-100 dark:hover:bg-neutral-800">SQL insert</button>
        <button onClick={() => setView(view === 'table' ? 'chart' : 'table')} className="rounded border px-2 py-0.5 hover:bg-neutral-100 dark:hover:bg-neutral-800">
          {view === 'table' ? 'Chart view' : 'Table view'}
        </button>
        <CopyButton label="Copy" getText={() => toCsv(safeCols, safeRows)} />
      </div>
      {/* Client-side pivot control — regroups the loaded rows without re-querying. */}
      {baseCols.length >= 1 && (
        <PivotControl columns={baseCols} value={pv} onChange={(v) => { setPv(v); if (v) setView('table'); }} />
      )}
      {pivoted && (
        <p className="mb-1 text-xs text-amber-600">
          Pivot over the {baseRows.length} loaded rows
          {baseRows.length >= SAFETY_CAP ? ' — may be capped at 500; ask the agent to GROUP BY for the full table' : ''}.
        </p>
      )}
      {view === 'chart' && (
        <>
          <button onClick={() => setPickerOpen(!pickerOpen)} className="mb-1 text-xs text-blue-600 hover:underline" data-testid="chart-config-toggle">
            ⚙ Chart config
          </button>
          {pickerOpen && <ChartConfigPicker columns={safeCols} value={chartSpec} onApply={(s) => setChartSpec(s)} />}
          <ResultChart columns={safeCols} rows={safeRows} spec={chartSpec} />
        </>
      )}
      <div className="max-h-80 overflow-auto rounded border border-neutral-200 dark:border-neutral-800">
        <table className="w-full border-collapse text-xs">
          <thead className="sticky top-0 bg-neutral-100 dark:bg-neutral-800">
            <tr>
              {safeCols.map((c) => (
                <th key={c} className="border-b border-neutral-300 px-2 py-1 text-left font-medium dark:border-neutral-700">{c}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {shown.map((row, i) => (
              <tr key={i} className="odd:bg-neutral-50 dark:odd:bg-neutral-900">
                {row.map((cell, j) => (
                  <td key={j} className="border-b border-neutral-100 px-2 py-1 align-top dark:border-neutral-800">
                    {cell == null ? <span className="text-neutral-400">null</span> : String(cell)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {truncated && <p className="mt-1 text-xs text-amber-600">Showing first {RENDER_CAP} of {safeRows.length} rows (full set in CSV export).</p>}
    </div>
  );
}

/** Group-by / value / aggregate selectors for a client-side pivot. */
function PivotControl({ columns, value, onChange }: {
  columns: string[];
  value: { group: string; value: string; agg: PivotAgg } | null;
  onChange: (v: { group: string; value: string; agg: PivotAgg } | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const [group, setGroup] = useState(columns[0] ?? '');
  const [val, setVal] = useState(columns[1] ?? '');
  const [agg, setAgg] = useState<PivotAgg>('count');
  if (!open && !value) {
    return <button onClick={() => setOpen(true)} className="mb-1 text-xs text-blue-600 hover:underline">⊞ Pivot / group by</button>;
  }
  return (
    <div className="mb-1 flex flex-wrap items-center gap-1 text-xs">
      <span className="text-neutral-500">Group by</span>
      <select value={group} onChange={(e) => setGroup(e.target.value)} className="rounded border p-0.5 dark:bg-neutral-900">
        {columns.map((c) => <option key={c} value={c}>{c}</option>)}
      </select>
      <select value={agg} onChange={(e) => setAgg(e.target.value as PivotAgg)} className="rounded border p-0.5 dark:bg-neutral-900">
        {(['count', 'sum', 'avg', 'min', 'max'] as PivotAgg[]).map((a) => <option key={a} value={a}>{a}</option>)}
      </select>
      {agg !== 'count' && (
        <select value={val} onChange={(e) => setVal(e.target.value)} className="rounded border p-0.5 dark:bg-neutral-900">
          {columns.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
      )}
      <button onClick={() => onChange({ group, value: agg === 'count' ? '' : val, agg })} className="rounded bg-blue-600 px-2 py-0.5 text-white">Apply</button>
      <button onClick={() => { onChange(null); setOpen(false); }} className="rounded border px-2 py-0.5">Reset</button>
    </div>
  );
}
