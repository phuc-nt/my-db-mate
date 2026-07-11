'use client';

import { use, useEffect, useState, useCallback } from 'react';
import Link from 'next/link';
import { ResultTable } from '../../../../../components/result-table';

interface Bookmark { id: string; name: string; sql: string }

export default function BookmarksPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [list, setList] = useState<Bookmark[]>([]);
  const [result, setResult] = useState<{ columns: string[]; rows: unknown[][] } | undefined>();
  const [msg, setMsg] = useState('');
  const [dialect, setDialect] = useState<'postgres' | 'mysql' | 'sqlite' | 'mssql'>();

  const load = useCallback(async () => {
    setList(await (await fetch(`/api/connections/${id}/bookmarks`)).json());
  }, [id]);
  useEffect(() => {
    load();
    fetch(`/api/connections/${id}/schema`).then((r) => r.json()).then((d) => setDialect(d.dialect)).catch(() => {});
  }, [id, load]);

  const [confirm, setConfirm] = useState<{ qid: string; reason: string } | undefined>();

  async function run(qid: string, confirmed = false) {
    setResult(undefined); setMsg('Running…'); setConfirm(undefined);
    const r = await fetch(`/api/connections/${id}/bookmarks/${qid}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ confirmed }),
    });
    const d = await r.json();
    if (d.status === 'ok') { setResult({ columns: d.columns, rows: d.rows }); setMsg(''); }
    else if (d.status === 'needs_confirmation') { setMsg(''); setConfirm({ qid, reason: d.risk?.reason ?? 'medium-risk query' }); }
    else setMsg(d.reason ?? d.error ?? d.status);
  }

  async function remove(qid: string) {
    await fetch(`/api/connections/${id}/bookmarks/${qid}`, { method: 'DELETE' });
    load();
  }

  return (
    <main className="mx-auto max-w-3xl p-6">
      <div className="mb-3 flex items-center justify-between">
        <h1 className="text-lg font-semibold">Bookmarks</h1>
        <Link href={`/db/${id}/schema`} className="text-sm text-blue-600">← Browse</Link>
      </div>
      {list.length === 0 && <p className="text-sm text-neutral-500">No bookmarks. Run a query in chat, then ⭐ Bookmark it.</p>}
      <ul className="space-y-2">
        {list.map((b) => (
          <li key={b.id} className="rounded border border-neutral-200 p-2 dark:border-neutral-800">
            <div className="flex items-center justify-between">
              <span className="font-medium">{b.name}</span>
              <div className="flex gap-2 text-xs">
                <button onClick={() => run(b.id)} className="text-blue-600">Run</button>
                <button onClick={() => remove(b.id)} className="text-red-600">Delete</button>
              </div>
            </div>
            <pre className="mt-1 overflow-x-auto text-xs text-neutral-500">{b.sql}</pre>
          </li>
        ))}
      </ul>
      {msg && <p className="mt-3 text-sm text-amber-600">{msg}</p>}
      {confirm && (
        <div className="mt-3 rounded border border-amber-300 bg-amber-50 p-2 text-sm text-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
          ⚠ Medium-risk query ({confirm.reason}).{' '}
          <button onClick={() => run(confirm.qid, true)} className="underline">Confirm & run</button>
        </div>
      )}
      {result && <ResultTable columns={result.columns} rows={result.rows} dialect={dialect} />}
    </main>
  );
}
