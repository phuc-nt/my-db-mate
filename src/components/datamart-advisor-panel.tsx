'use client';

import { useState } from 'react';
import Link from 'next/link';
import { MartCard } from './datamart-advisor-mart-card';
import type { AdoptionResult, ProposeResponse, ValidatedProposal } from './datamart-advisor-types';

/** Hand a rendered file to the browser without a server round trip — the export
 *  route returns text, and text is all any of this ever produces. */
function download(filename: string, contents: string) {
  const url = URL.createObjectURL(new Blob([contents], { type: 'text/plain' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename.replace(/[/\\]/g, '__');
  a.click();
  URL.revokeObjectURL(url);
}

/**
 * The datamart advisor: draft the marts this warehouse would have if someone
 * had planned it, then either hand them to the data team as files or adopt them
 * as governed views right now.
 *
 * The advisory-only posture is stated on the page at all times, not just in the
 * docs, because the whole feature reads like something that might create tables
 * — and the one thing an owner must never be unsure about is whether a tool
 * pointed at their warehouse writes to it.
 */
export function DatamartAdvisorPanel({ connectionId }: { connectionId: string }) {
  const [res, setRes] = useState<ProposeResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [dataset, setDataset] = useState('marts');
  const [adoption, setAdoption] = useState<AdoptionResult | null>(null);

  const proposal: ValidatedProposal | null = res?.proposal ?? null;

  const toggle = (martName: string, summaryTableName: string) => {
    const key = `${martName} ${summaryTableName}`;
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  };

  const selectionPayload = () =>
    [...selected].map((k) => {
      const i = k.indexOf(' ');
      return { martName: k.slice(0, i), summaryTableName: k.slice(i + 1) };
    });

  async function run() {
    setBusy(true); setErr(''); setRes(null); setAdoption(null); setSelected(new Set());
    try {
      const r = await fetch(`/api/connections/${connectionId}/datamart-advisor/propose`, { method: 'POST' });
      const d: ProposeResponse = await r.json();
      if (!r.ok || d.error) setErr(d.error ?? 'The advisor could not finish.');
      else {
        setRes(d);
        // Everything that validated starts ticked: the owner is more likely to
        // be pruning a draft than assembling one from nothing.
        setSelected(new Set(
          d.proposal.marts.flatMap((m) => m.summaryTables.filter((s) => s.valid).map((s) => `${m.name} ${s.name}`)),
        ));
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
    setBusy(false);
  }

  async function exportAs(target: 'bq-ddl' | 'dbt') {
    if (!proposal) return;
    setBusy(true); setErr('');
    try {
      const r = await fetch(`/api/connections/${connectionId}/datamart-advisor/export`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ proposal, target, targetDataset: dataset }),
      });
      const d = await r.json();
      if (!r.ok || d.error) setErr(d.error ?? 'Export failed.');
      else for (const f of d.files as { filename: string; contents: string }[]) download(f.filename, f.contents);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
    setBusy(false);
  }

  async function adopt() {
    if (!proposal || selected.size === 0) return;
    setBusy(true); setErr(''); setAdoption(null);
    try {
      const r = await fetch(`/api/connections/${connectionId}/datamart-advisor/adopt`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ proposal, selection: selectionPayload() }),
      });
      const d = await r.json();
      if (!r.ok || d.error) setErr(d.error ?? 'Adoption failed.');
      else setAdoption(d as AdoptionResult);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
    setBusy(false);
  }

  return (
    <div className="space-y-3 text-sm">
      <div className="rounded-lg border border-blue-200 bg-blue-50 p-3 text-xs dark:border-blue-900 dark:bg-blue-950/40">
        <p className="font-medium text-blue-900 dark:text-blue-100">
          This product creates nothing in your warehouse — the DDL is for your own data team to run.
        </p>
        <p className="mt-1 text-blue-800 dark:text-blue-200">
          The advisor reads only what is already in this app: the synced schema, declared
          relationships, existing column profiles, and this connection&apos;s own query history.
          Proposed statements are checked with a BigQuery dry run, which is never billed and
          never touches your daily budget. It costs one model call, about a minute.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <button
          onClick={run}
          disabled={busy}
          className="rounded bg-neutral-900 px-3 py-1.5 text-xs text-white hover:bg-neutral-700 disabled:opacity-50 dark:bg-neutral-100 dark:text-neutral-900"
        >
          {busy ? 'Working…' : proposal ? 'Draft again' : 'Draft datamarts'}
        </button>
        {res && (
          <span className="text-xs text-neutral-500">
            {res.tablesSurveyed} tables surveyed · {res.runsRead} audited runs read
          </span>
        )}
      </div>

      {err && <p className="rounded bg-red-50 p-2 text-xs text-red-700 dark:bg-red-950/40 dark:text-red-300">{err}</p>}

      {res?.degraded && (
        <div className="rounded border border-amber-300 bg-amber-50 p-2 text-xs dark:border-amber-900 dark:bg-amber-950/30">
          <p className="font-medium text-amber-900 dark:text-amber-100">The survey was incomplete.</p>
          <ul className="mt-1 list-disc pl-4 text-amber-800 dark:text-amber-200">
            {res.degradedReasons.map((r, i) => <li key={i}>{r}</li>)}
          </ul>
        </div>
      )}

      {proposal && (
        <>
          {proposal.notes && (
            <p className="rounded bg-neutral-50 p-2 text-xs text-neutral-600 dark:bg-neutral-900 dark:text-neutral-300">
              {proposal.notes}
            </p>
          )}

          <div className="space-y-3">
            {proposal.marts.map((m) => (
              <MartCard key={m.name} mart={m} selected={selected} onToggle={toggle} />
            ))}
          </div>

          <div className="rounded-lg border border-neutral-200 p-3 dark:border-neutral-800">
            <p className="mb-2 text-xs text-neutral-500">
              {selected.size} statement{selected.size === 1 ? '' : 's'} selected.
            </p>
            <div className="mb-2 flex items-center gap-2 text-xs">
              <label htmlFor="mart-dataset" className="text-neutral-500">Target dataset for DDL</label>
              <input
                id="mart-dataset"
                value={dataset}
                onChange={(e) => setDataset(e.target.value)}
                className="w-40 rounded border border-neutral-300 px-2 py-1 font-mono dark:border-neutral-700 dark:bg-neutral-900"
              />
            </div>
            <div className="flex flex-wrap gap-2">
              <button onClick={() => exportAs('bq-ddl')} disabled={busy} className="rounded border px-3 py-1 text-xs hover:bg-neutral-100 disabled:opacity-50 dark:hover:bg-neutral-800">
                Download DDL
              </button>
              <button onClick={() => exportAs('dbt')} disabled={busy} className="rounded border px-3 py-1 text-xs hover:bg-neutral-100 disabled:opacity-50 dark:hover:bg-neutral-800">
                Download dbt scaffold
              </button>
              <button onClick={adopt} disabled={busy || selected.size === 0} className="rounded bg-neutral-900 px-3 py-1 text-xs text-white hover:bg-neutral-700 disabled:opacity-50 dark:bg-neutral-100 dark:text-neutral-900">
                Adopt as governed views
              </button>
            </div>
          </div>
        </>
      )}

      {adoption && (
        <div className="rounded-lg border border-neutral-200 p-3 text-xs dark:border-neutral-800">
          {adoption.adopted.length > 0 && (
            <>
              <p className="font-medium text-green-700 dark:text-green-400">
                {adoption.adopted.length} view{adoption.adopted.length === 1 ? '' : 's'} adopted.
              </p>
              <ul className="mt-1 font-mono text-neutral-600 dark:text-neutral-300">
                {adoption.adopted.map((a) => <li key={a.viewId}>{a.viewName}</li>)}
              </ul>
              {/* The payoff of the whole feature: a curated layer only pays off
                  once the agent is held to it. */}
              <p className="mt-2 text-neutral-600 dark:text-neutral-300">
                Next: review them in{' '}
                <Link href={`/db/${connectionId}/context`} className="text-blue-600">Context Studio</Link>
                , then turn on <span className="font-medium">Governed views only</span> in{' '}
                <Link href={`/db/${connectionId}/schema`} className="text-blue-600">Scope</Link>{' '}
                so the agent answers from these definitions instead of assembling numbers from raw tables.
              </p>
            </>
          )}
          {adoption.failed.length > 0 && (
            <>
              <p className="mt-2 font-medium text-red-700 dark:text-red-400">
                {adoption.failed.length} could not be adopted:
              </p>
              <ul className="mt-1 text-neutral-600 dark:text-neutral-300">
                {adoption.failed.map((f) => (
                  <li key={f.viewName}><span className="font-mono">{f.viewName}</span> — {f.reason}</li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}
    </div>
  );
}
