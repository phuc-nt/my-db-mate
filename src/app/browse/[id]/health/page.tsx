'use client';

import { use, useEffect, useState, useCallback } from 'react';
import Link from 'next/link';

interface Flag { tableName: string; columnName: string; issue: string; detail: string }
interface Health { flags: Flag[]; profiledColumns: number; totalColumns: number }

const ISSUE_LABEL: Record<string, string> = {
  high_null: '⚠ High NULL rate',
  single_value: '① Single value',
  near_unique: '🔑 Near-unique (id-like)',
};

export default function DataHealthPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [health, setHealth] = useState<Health | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');

  const load = useCallback(async () => {
    setHealth(await (await fetch(`/api/connections/${id}/data-health`)).json());
  }, [id]);
  useEffect(() => { load(); }, [load]);

  async function profile() {
    setBusy(true); setMsg('Profiling (this runs inline and may take a moment)…');
    const r = await fetch(`/api/connections/${id}/data-health`, { method: 'POST' });
    const d = await r.json();
    setMsg(`Profiled ${d.scanned} column(s)${d.failed ? `, ${d.failed} failed` : ''}.`);
    setBusy(false);
    load();
  }

  const partial = health && health.profiledColumns > 0 && health.profiledColumns < health.totalColumns;

  return (
    <main className="mx-auto max-w-3xl p-6">
      <div className="mb-3 flex items-center justify-between">
        <h1 className="text-lg font-semibold">Data Health</h1>
        <Link href={`/browse/${id}`} className="text-sm text-blue-600">← Browse</Link>
      </div>
      <div className="mb-3 flex items-center gap-3">
        <button onClick={profile} disabled={busy} className="rounded bg-blue-600 px-4 py-2 text-sm text-white disabled:opacity-50">{busy ? 'Profiling…' : 'Profile data quality'}</button>
        {msg && <span className="text-xs text-neutral-500">{msg}</span>}
      </div>

      {!health ? (
        <p className="text-sm text-neutral-500">Loading…</p>
      ) : health.profiledColumns === 0 ? (
        <p className="text-sm text-neutral-500">Not profiled yet — click “Profile data quality”.</p>
      ) : (
        <>
          <p className="mb-3 text-xs text-neutral-400">
            Profiled {health.profiledColumns} of {health.totalColumns} columns.
            {partial && <span className="ml-1 text-amber-600">Partial scan — some columns not profiled.</span>}
          </p>
          {health.flags.length === 0 ? (
            <p className="text-sm text-green-600">No data-quality issues flagged in the profiled columns.</p>
          ) : (
            <ul className="space-y-1 text-sm">
              {health.flags.map((f, i) => (
                <li key={i} className="flex items-center justify-between rounded border border-neutral-200 p-2 dark:border-neutral-800">
                  <span className="font-mono text-xs">{f.tableName}.{f.columnName}</span>
                  <span className="text-xs">{ISSUE_LABEL[f.issue] ?? f.issue} · {f.detail}</span>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </main>
  );
}
