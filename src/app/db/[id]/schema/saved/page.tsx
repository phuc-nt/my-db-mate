'use client';

import { use, useEffect, useState, useCallback } from 'react';
import Link from 'next/link';
import { ResultTable } from '../../../../../components/result-table';
import { FormModal } from '../../../../../components/form-modal';

interface Bookmark { id: string; name: string; sql: string }
interface Verified { id: string; question: string; sql: string; isDisabled: boolean }

export default function BookmarksPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [list, setList] = useState<Bookmark[]>([]);
  const [verified, setVerified] = useState<Verified[]>([]);
  const [result, setResult] = useState<{ columns: string[]; rows: unknown[][] } | undefined>();
  const [msg, setMsg] = useState('');
  const [dialect, setDialect] = useState<'postgres' | 'mysql' | 'sqlite' | 'mssql'>();

  const load = useCallback(async () => {
    setList(await (await fetch(`/api/connections/${id}/bookmarks`)).json());
    const ctx = await (await fetch(`/api/connections/${id}/context`)).json();
    setVerified(ctx.verified ?? []);
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

  /** Promote a bookmark into a verified query. Goes through the standard create
   *  path (POST context) so the embedding is computed — a flag-flip would leave
   *  the query invisible to retrieval — then removes the bookmark to avoid dupes. */
  const [promoting, setPromoting] = useState<Bookmark | null>(null);
  async function promote(b: Bookmark, question: string) {
    if (!question?.trim()) return;
    const r = await fetch(`/api/connections/${id}/context`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'verified_query', question, sql: b.sql }),
    });
    if (!r.ok) { setMsg('promote failed'); return; }
    await fetch(`/api/connections/${id}/bookmarks/${b.id}`, { method: 'DELETE' });
    setMsg(`Promoted "${question}" to verified ✓`);
    load();
  }

  return (
    <main className="mx-auto max-w-3xl p-6">
      <div className="mb-3 flex items-center justify-between">
        <h1 className="text-lg font-semibold">Saved queries</h1>
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
                <button onClick={() => setPromoting(b)} className="text-amber-600" title="Verified queries are retrieved as few-shot examples for the agent">Promote to verified</button>
                <button onClick={() => remove(b.id)} className="text-red-600">Delete</button>
              </div>
            </div>
            <pre className="mt-1 overflow-x-auto text-xs text-neutral-500">{b.sql}</pre>
          </li>
        ))}
      </ul>

      <h2 className="mb-2 mt-6 text-sm font-semibold">Verified queries <span className="font-normal text-neutral-400">(retrieved as examples by the agent — manage in Context Studio)</span></h2>
      {verified.length === 0 && <p className="text-sm text-neutral-500">None yet. Promote a bookmark, or save one from a chat result.</p>}
      <ul className="space-y-2">
        {verified.map((v) => (
          <li key={v.id} className="rounded border border-neutral-200 p-2 dark:border-neutral-800">
            <div className="flex items-center justify-between">
              <span className="font-medium">{v.question}</span>
              <span className="text-xs text-neutral-400">{v.isDisabled ? 'disabled' : 'verified ✓'}</span>
            </div>
            <pre className="mt-1 overflow-x-auto text-xs text-neutral-500">{v.sql}</pre>
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
          {promoting && (
        <FormModal open title="Promote bookmark to verified query" submitLabel="Promote"
          fields={[{ name: 'question', label: 'Question this query answers (used for retrieval)', defaultValue: promoting.name, required: true }]}
          onSubmit={(v) => { const b = promoting; setPromoting(null); promote(b, v.question.trim()); }} onClose={() => setPromoting(null)} />
      )}
    </main>
  );
}
