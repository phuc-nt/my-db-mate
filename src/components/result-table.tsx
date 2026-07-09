'use client';

import { useState } from 'react';
import { ResultChart } from './result-chart';
import { toCsv, toJson, toSqlInsert, downloadText, type ExportDialect } from '../lib/export-formats';

/** Renders a SQL result set as a table with CSV/JSON/SQL export + optional chart
 *  view. Caps rendered rows for large results (server already caps via LIMIT). */
const RENDER_CAP = 200;

export function ResultTable({ columns, rows, dialect = 'sqlite' }: { columns: string[]; rows: unknown[][]; dialect?: ExportDialect }) {
  const [view, setView] = useState<'table' | 'chart'>('table');
  const safeRows = rows ?? [];
  const safeCols = columns ?? [];
  const shown = safeRows.slice(0, RENDER_CAP);
  const truncated = safeRows.length > RENDER_CAP;

  if (safeCols.length === 0) return <p className="text-xs text-neutral-500">No columns.</p>;

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
      </div>
      {view === 'chart' && <ResultChart columns={safeCols} rows={safeRows} />}
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
