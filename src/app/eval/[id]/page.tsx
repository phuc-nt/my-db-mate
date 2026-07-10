'use client';

import { use, useEffect, useState, useCallback } from 'react';
import Link from 'next/link';

interface EvalQuery { id: string; question: string; goldSql: string; complexity: string }
interface EvalRun { id: string; total: number; executionMatch: number; structuralMatch: number; createdAt: string }

export default function EvalPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [queries, setQueries] = useState<EvalQuery[]>([]);
  const [runs, setRuns] = useState<EvalRun[]>([]);
  const [f, setF] = useState({ question: '', goldSql: '' });
  const [running, setRunning] = useState(false);
  const [msg, setMsg] = useState('');

  const load = useCallback(() => {
    fetch(`/api/connections/${id}/eval`).then((r) => r.json()).then((d) => { setQueries(d.queries); setRuns(d.runs); });
  }, [id]);
  useEffect(() => { load(); }, [load]);

  async function add() {
    await fetch(`/api/connections/${id}/eval`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'add', ...f }) });
    setF({ question: '', goldSql: '' }); load();
  }
  async function run() {
    setRunning(true); setMsg('Running eval (asks the agent for each gold query)…');
    const r = await fetch(`/api/connections/${id}/eval`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'run' }) });
    const d = await r.json();
    setMsg(d.error ? `error: ${d.error}` : `Done: execution ${d.executionMatch}/${d.total}, structural ${d.structuralMatch}/${d.total}`);
    setRunning(false); load();
  }

  return (
    <main className="mx-auto max-w-3xl p-6">
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-xl font-semibold">Eval</h1>
      </div>

      <div className="mb-4 rounded border border-neutral-200 p-3 dark:border-neutral-800">
        <h2 className="mb-2 text-sm font-medium">Add gold query</h2>
        <input className="mb-2 w-full rounded border p-2 dark:bg-neutral-900" placeholder="Question (NL)" value={f.question} onChange={(e) => setF({ ...f, question: e.target.value })} />
        <textarea className="mb-2 w-full rounded border p-2 font-mono text-sm dark:bg-neutral-900" placeholder="Gold SQL" rows={2} value={f.goldSql} onChange={(e) => setF({ ...f, goldSql: e.target.value })} />
        <button onClick={add} disabled={!f.question || !f.goldSql} className="rounded bg-blue-600 px-3 py-1 text-white disabled:opacity-50">Add</button>
      </div>

      <div className="mb-4 flex items-center gap-3">
        <button onClick={run} disabled={running || queries.length === 0} className="rounded bg-neutral-800 px-4 py-2 text-white disabled:opacity-50 dark:bg-neutral-200 dark:text-neutral-900">Run eval ({queries.length})</button>
        {msg && <span className="text-sm text-neutral-500">{msg}</span>}
      </div>

      <h2 className="mb-2 text-sm font-medium">Runs (accuracy trend)</h2>
      <ul className="mb-4 space-y-1 text-sm">
        {runs.map((r) => (
          <li key={r.id} className="rounded border border-neutral-200 p-2 dark:border-neutral-800">
            execution {r.executionMatch}/{r.total} ({Math.round((r.executionMatch / r.total) * 100)}%) · structural {r.structuralMatch}/{r.total}
            <span className="ml-2 text-xs text-neutral-400">{new Date(r.createdAt).toLocaleString()}</span>
          </li>
        ))}
        {runs.length === 0 && <li className="text-neutral-500">No runs yet.</li>}
      </ul>

      <h2 className="mb-2 text-sm font-medium">Gold queries ({queries.length})</h2>
      <ul className="space-y-1 text-xs">
        {queries.map((q) => <li key={q.id} className="rounded border border-neutral-200 p-2 dark:border-neutral-800"><b>{q.question}</b><br /><code>{q.goldSql}</code></li>)}
      </ul>
    </main>
  );
}
