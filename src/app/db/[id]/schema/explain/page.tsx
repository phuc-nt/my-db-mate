'use client';

import { use, useState } from 'react';
import Link from 'next/link';

interface ExplainOk { status: 'ok'; dialect: string; estimatedRows: number | null; hasFullScan: boolean; tableCount: number; raw: string | null }

export default function ExplainPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [sql, setSql] = useState('');
  const [result, setResult] = useState<ExplainOk | undefined>();
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);

  async function run() {
    if (!sql.trim()) return;
    setBusy(true); setResult(undefined); setMsg('');
    const r = await fetch(`/api/connections/${id}/explain`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sql }),
    });
    const d = await r.json();
    if (d.status === 'ok') setResult(d);
    else setMsg(d.message ?? 'error');
    setBusy(false);
  }

  return (
    <main className="mx-auto max-w-3xl p-6">
      <div className="mb-3 flex items-center justify-between">
        <h1 className="text-lg font-semibold">Explain a query</h1>
        <Link href={`/db/${id}/schema`} className="text-sm text-blue-600">← Browse</Link>
      </div>
      <textarea
        className="mb-2 w-full resize-y rounded border border-neutral-300 bg-neutral-50 p-2 font-mono text-xs dark:border-neutral-700 dark:bg-neutral-900"
        rows={4}
        placeholder="SELECT ... (read-only; EXPLAIN only, never runs the query)"
        value={sql}
        onChange={(e) => setSql(e.target.value)}
      />
      <button onClick={run} disabled={busy} className="rounded bg-blue-600 px-4 py-2 text-sm text-white disabled:opacity-50">{busy ? 'Explaining…' : 'Explain'}</button>
      {msg && <p className="mt-2 text-sm text-amber-600">{msg}</p>}
      {result && (
        <div className="mt-4 space-y-3 text-sm">
          <div className="flex flex-wrap gap-4">
            <span>Dialect: <b>{result.dialect}</b></span>
            {result.estimatedRows != null && <span>Est. rows: <b>{result.estimatedRows.toLocaleString()}</b></span>}
            <span>Tables: <b>{result.tableCount}</b></span>
          </div>
          {result.hasFullScan && (
            <div className="rounded border border-amber-300 bg-amber-50 p-2 text-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
              ⚠ This plan includes a <b>full table scan</b> — it reads the whole table. Consider filtering on an indexed column.
            </div>
          )}
          <div>
            <div className="mb-1 font-medium text-neutral-500">Plan</div>
            {/* raw is rendered as escaped text (React escapes by default) — safe even
                for untrusted remote (D1) plan bodies. */}
            <pre className="overflow-x-auto rounded bg-neutral-100 p-2 text-xs dark:bg-neutral-900">{result.raw ?? 'Plan text unavailable for this dialect.'}</pre>
          </div>
        </div>
      )}
    </main>
  );
}
