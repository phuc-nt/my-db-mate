'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { ResultTable } from './result-table';

interface Column { columnName: string; dataType: string; isPrimaryKey: boolean; isNullable: boolean }
interface Table { tableName: string; rowCount: number | null; columns: Column[] }

/** Compact schema browser for the chat workspace panel — check a table/column and
 *  sample rows without leaving the conversation. Same APIs as the Schema section. */
export function SchemaPeek({ connectionId }: { connectionId: string }) {
  const [tables, setTables] = useState<Table[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const [sample, setSample] = useState<{ table: string; columns: string[]; rows: unknown[][] } | null>(null);
  const [msg, setMsg] = useState('loading…');

  useEffect(() => {
    fetch(`/api/connections/${connectionId}/schema`)
      .then((r) => r.json())
      .then((d) => { setTables(d.tables ?? []); setMsg(''); })
      .catch(() => setMsg('failed to load schema'));
  }, [connectionId]);

  async function loadSample(table: string) {
    setSample(null); setMsg(`sampling ${table}…`);
    const r = await fetch(`/api/connections/${connectionId}/sample-rows`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ table }),
    });
    const d = await r.json();
    if (d.columns) { setSample({ table, columns: d.columns, rows: d.rows ?? [] }); setMsg(''); }
    else setMsg(d.error ?? 'sample failed');
  }

  return (
    <div className="text-xs">
      <div className="mb-2 flex items-center justify-between">
        <span className="font-medium text-neutral-500">Schema peek</span>
        <Link href={`/db/${connectionId}/schema`} className="text-blue-600 hover:underline">full schema →</Link>
      </div>
      {msg && <p className="text-neutral-400">{msg}</p>}
      <ul className="space-y-1">
        {tables.map((t) => (
          <li key={t.tableName} className="rounded border border-neutral-200 dark:border-neutral-800">
            <button onClick={() => setOpen(open === t.tableName ? null : t.tableName)}
              className="flex w-full items-center justify-between px-2 py-1 text-left hover:bg-neutral-50 dark:hover:bg-neutral-900">
              <span className="font-mono">{t.tableName}</span>
              <span className="text-neutral-400">{t.rowCount?.toLocaleString() ?? '—'} rows</span>
            </button>
            {open === t.tableName && (
              <div className="border-t border-neutral-100 p-2 dark:border-neutral-800">
                <table className="w-full">
                  <tbody>
                    {t.columns.map((c) => (
                      <tr key={c.columnName}>
                        <td className="pr-2 font-mono">{c.isPrimaryKey ? '🔑 ' : ''}{c.columnName}</td>
                        <td className="text-neutral-400">{c.dataType}{c.isNullable ? '' : ' · not null'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <button onClick={() => loadSample(t.tableName)} className="mt-1 text-blue-600 hover:underline">Sample rows</button>
              </div>
            )}
          </li>
        ))}
      </ul>
      {sample && (
        <div className="mt-2">
          <div className="mb-1 font-medium text-neutral-500">Sample: {sample.table}</div>
          <ResultTable columns={sample.columns} rows={sample.rows} />
        </div>
      )}
    </div>
  );
}
