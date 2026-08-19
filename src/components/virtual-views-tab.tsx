'use client';

import { useCallback, useEffect, useState } from 'react';

interface ViewColumn { name: string; type: string }

interface VirtualView {
  id: string;
  name: string;
  description: string | null;
  sql: string;
  columnsCache: ViewColumn[] | null;
  isDisabled: boolean;
}

interface Preview { columns: string[]; rows: unknown[][] }

const BLANK = { name: '', description: '', sql: '' };

/**
 * Curated views: the business definitions this connection agrees on.
 *
 * The editor's job is to make a definition cheap to get right and expensive to
 * get wrong. Preview runs the candidate SQL through the real executor before
 * anything is saved, so the author sees actual rows — and sees a refusal here,
 * on their own screen, rather than discovering it later when a reader's question
 * fails. Saving is what publishes a definition to the agent, so it happens only
 * after the author has looked at what the definition returns.
 */
export function VirtualViewsTab({ connectionId }: { connectionId: string }) {
  const [views, setViews] = useState<VirtualView[]>([]);
  const [form, setForm] = useState(BLANK);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const r = await fetch(`/api/connections/${connectionId}/views`);
    const d = await r.json();
    setViews(d.views ?? []);
  }, [connectionId]);

  useEffect(() => { load(); }, [load]);

  const reset = () => { setForm(BLANK); setEditingId(null); setPreview(null); setError(''); };

  async function runPreview() {
    setBusy(true); setError(''); setPreview(null);
    const r = await fetch(`/api/connections/${connectionId}/views/preview`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sql: form.sql }),
    });
    const d = await r.json();
    if (d.error) setError(d.error); else setPreview(d);
    setBusy(false);
  }

  async function save() {
    setBusy(true); setError('');
    const url = editingId
      ? `/api/connections/${connectionId}/views/${editingId}`
      : `/api/connections/${connectionId}/views`;
    const r = await fetch(url, {
      method: editingId ? 'PATCH' : 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(form),
    });
    const d = await r.json();
    if (d.error) setError(d.error);
    else { reset(); await load(); }
    setBusy(false);
  }

  async function toggle(v: VirtualView) {
    await fetch(`/api/connections/${connectionId}/views/${v.id}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ isDisabled: !v.isDisabled }),
    });
    await load();
  }

  async function remove(v: VirtualView) {
    await fetch(`/api/connections/${connectionId}/views/${v.id}`, { method: 'DELETE' });
    await load();
  }

  function edit(v: VirtualView) {
    setEditingId(v.id);
    setForm({ name: v.name, description: v.description ?? '', sql: v.sql });
    setPreview(null); setError('');
  }

  return (
    <div>
      <p className="mb-3 text-xs text-neutral-500">
        A view pairs a business name with the SQL everyone agreed it means. The agent
        prefers views over raw tables, and the definition travels with the number —
        so &ldquo;revenue&rdquo; means the same thing in every answer.
      </p>

      <div className="mb-4 rounded border border-neutral-200 p-3 dark:border-neutral-800">
        <div className="mb-2 grid grid-cols-2 gap-2">
          <input
            className="rounded border p-2 font-mono text-sm dark:bg-neutral-900"
            placeholder="view name (e.g. monthly_revenue)"
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
          />
          <input
            className="rounded border p-2 text-sm dark:bg-neutral-900"
            placeholder="what it means in business terms"
            value={form.description}
            onChange={(e) => setForm({ ...form, description: e.target.value })}
          />
        </div>
        <textarea
          className="w-full rounded border p-2 font-mono text-xs dark:bg-neutral-900"
          rows={5}
          placeholder="SELECT region, SUM(revenue) AS revenue FROM orders WHERE status = 'paid' GROUP BY region"
          value={form.sql}
          onChange={(e) => setForm({ ...form, sql: e.target.value })}
        />
        <div className="mt-2 flex items-center gap-2">
          <button onClick={runPreview} disabled={busy || !form.sql.trim()}
            className="rounded border px-3 py-1 text-xs disabled:opacity-50">
            {busy ? 'Running…' : 'Preview'}
          </button>
          <button onClick={save} disabled={busy || !form.name.trim() || !form.sql.trim()}
            className="rounded bg-blue-600 px-3 py-1 text-xs text-white disabled:opacity-50">
            {editingId ? 'Save changes' : 'Create view'}
          </button>
          {editingId && (
            <button onClick={reset} className="rounded border px-3 py-1 text-xs">Cancel</button>
          )}
        </div>

        {error && <p className="mt-2 text-xs text-red-600">{error}</p>}

        {preview && (
          <div className="mt-2 overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead>
                <tr className="border-b border-neutral-200 dark:border-neutral-800">
                  {preview.columns.map((c) => <th key={c} className="py-1 pr-3 font-medium">{c}</th>)}
                </tr>
              </thead>
              <tbody>
                {preview.rows.map((row, i) => (
                  <tr key={i} className="border-b border-neutral-100 dark:border-neutral-900">
                    {row.map((cell, j) => (
                      <td key={j} className="py-1 pr-3 font-mono">{cell === null ? '∅' : String(cell)}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
            {preview.rows.length === 0 && <p className="text-xs text-neutral-500">No rows.</p>}
          </div>
        )}
      </div>

      <ul className="space-y-2">
        {views.map((v) => (
          <li key={v.id} className={`rounded border border-neutral-200 p-2 dark:border-neutral-800 ${v.isDisabled ? 'opacity-50' : ''}`}>
            <div className="flex items-center justify-between">
              <div className="min-w-0">
                <span className="font-mono text-sm font-medium">{v.name}</span>
                {v.isDisabled && <span className="ml-2 text-xs text-neutral-500">(disabled)</span>}
                {v.description && <span className="ml-2 text-xs text-neutral-500">{v.description}</span>}
              </div>
              <div className="flex shrink-0 gap-2 text-xs">
                <button onClick={() => edit(v)} className="text-blue-600">edit</button>
                <button onClick={() => toggle(v)} className="text-neutral-500">{v.isDisabled ? 'enable' : 'disable'}</button>
                <button onClick={() => remove(v)} className="text-red-600">delete</button>
              </div>
            </div>
            {v.columnsCache && v.columnsCache.length > 0 && (
              <p className="mt-1 font-mono text-xs text-neutral-500">
                {v.columnsCache.map((c) => c.name).join(', ')}
              </p>
            )}
          </li>
        ))}
        {views.length === 0 && (
          <li className="text-xs text-neutral-500">No views yet. The agent reads raw tables until you define some.</li>
        )}
      </ul>
    </div>
  );
}
