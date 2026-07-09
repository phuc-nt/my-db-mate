'use client';

import { use, useEffect, useState } from 'react';
import Link from 'next/link';
import { ResultTable } from '../../../components/result-table';

interface Column { columnName: string; dataType: string; isNullable: boolean; isPrimaryKey: boolean }
interface Table { id: string; tableName: string; rowCount: number | null; columns: Column[] }
interface FK { fromTable: string; fromColumn: string; toTable: string; toColumn: string }
interface SchemaData { dialect: 'postgres' | 'mysql' | 'sqlite'; tables: Table[]; foreignKeys: FK[] }

export default function BrowsePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [data, setData] = useState<SchemaData | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [sample, setSample] = useState<{ columns: string[]; rows: unknown[][] } | undefined>();
  const [sampleErr, setSampleErr] = useState('');
  const [loadingSample, setLoadingSample] = useState(false);

  useEffect(() => {
    fetch(`/api/connections/${id}/schema`).then((r) => r.json()).then(setData);
  }, [id]);

  const table = data?.tables.find((t) => t.tableName === selected);
  const tableFks = data?.foreignKeys.filter((f) => f.fromTable === selected || f.toTable === selected) ?? [];

  async function loadSample(name: string) {
    setLoadingSample(true); setSample(undefined); setSampleErr('');
    const r = await fetch(`/api/connections/${id}/sample-rows`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ table: name }),
    });
    const d = await r.json();
    if (d.error) setSampleErr(d.error); else setSample({ columns: d.columns, rows: d.rows });
    setLoadingSample(false);
  }

  if (!data) return <main className="p-6 text-sm text-neutral-500">Loading schema… (if empty, sync the connection first)</main>;

  return (
    <main className="mx-auto flex h-screen max-w-6xl gap-4 p-4">
      <aside className="w-64 shrink-0 overflow-y-auto rounded-lg border border-neutral-200 p-2 dark:border-neutral-800">
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-sm font-semibold">Tables ({data.tables.length})</h2>
          <div className="flex gap-2 text-xs">
            <Link href={`/browse/${id}/erd`} className="text-blue-600">ERD</Link>
            <Link href={`/browse/${id}/explain`} className="text-blue-600">Explain</Link>
            <Link href={`/browse/${id}/bookmarks`} className="text-blue-600">Bookmarks</Link>
            <Link href={`/browse/${id}/health`} className="text-blue-600">Health</Link>
          </div>
        </div>
        <ul className="space-y-0.5 text-sm">
          {data.tables.map((t) => (
            <li key={t.id}>
              <button
                onClick={() => { setSelected(t.tableName); setSample(undefined); setSampleErr(''); }}
                className={`flex w-full items-center justify-between rounded px-2 py-1 text-left hover:bg-neutral-100 dark:hover:bg-neutral-800 ${selected === t.tableName ? 'bg-neutral-100 font-medium dark:bg-neutral-800' : ''}`}
              >
                <span className="truncate">{t.tableName}</span>
                {t.rowCount != null && <span className="ml-2 shrink-0 text-xs text-neutral-400">{t.rowCount.toLocaleString()}</span>}
              </button>
            </li>
          ))}
        </ul>
      </aside>

      <section className="flex-1 overflow-y-auto rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
        <div className="mb-3 flex items-center justify-between">
          <Link href="/connections" className="text-sm text-blue-600">← Connections</Link>
          {selected && <Link href={`/chat/${id}`} className="text-sm text-blue-600">Chat →</Link>}
        </div>
        {!table ? (
          <p className="text-sm text-neutral-500">Select a table to see its columns, keys, and sample rows.</p>
        ) : (
          <>
            <h1 className="mb-2 text-lg font-semibold">{table.tableName} {table.rowCount != null && <span className="text-sm font-normal text-neutral-400">· {table.rowCount.toLocaleString()} rows</span>}</h1>
            <table className="mb-4 w-full text-sm">
              <thead><tr className="text-left text-neutral-500"><th className="py-1">Column</th><th>Type</th><th>Null?</th><th>Key</th></tr></thead>
              <tbody>
                {table.columns.map((c) => (
                  <tr key={c.columnName} className="border-t border-neutral-100 dark:border-neutral-800">
                    <td className="py-1 font-mono text-xs">{c.columnName}</td>
                    <td className="text-xs">{c.dataType}</td>
                    <td className="text-xs">{c.isNullable ? 'nullable' : 'not null'}</td>
                    <td className="text-xs">{c.isPrimaryKey ? '🔑 PK' : ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>

            {tableFks.length > 0 && (
              <div className="mb-4 text-xs text-neutral-500">
                <div className="mb-1 font-medium">Foreign keys</div>
                <ul className="space-y-0.5">
                  {tableFks.map((f, i) => <li key={i} className="font-mono">{f.fromTable}.{f.fromColumn} → {f.toTable}.{f.toColumn}</li>)}
                </ul>
              </div>
            )}

            <div className="mb-2 flex items-center gap-2">
              <button onClick={() => loadSample(table.tableName)} disabled={loadingSample} className="rounded border px-3 py-1 text-sm hover:bg-neutral-100 disabled:opacity-50 dark:hover:bg-neutral-800">
                {loadingSample ? 'Loading…' : 'Sample rows'}
              </button>
              <Link href={`/context-studio/${id}`} className="text-sm text-blue-600">Annotate in Context Studio</Link>
            </div>
            {sampleErr && <p className="text-xs text-amber-600">{sampleErr}</p>}
            {sample && <ResultTable columns={sample.columns} rows={sample.rows} dialect={data.dialect} />}
          </>
        )}
      </section>
    </main>
  );
}
