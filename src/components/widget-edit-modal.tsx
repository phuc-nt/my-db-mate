'use client';

import { useState } from 'react';

interface Proposal {
  sql: string;
  title?: string;
  chartSpec: unknown | null;
  rationale?: string;
  probe: { ok: boolean; rowCount?: number; dryRun?: boolean; error?: string };
  warnings: string[];
}

/** Two-step AI edit for one widget: instruction → diff preview (old vs proposed
 *  SQL + probe status + warnings) → Accept. A medium-risk apply asks for an
 *  in-modal confirm; closing at ANY point leaves the widget untouched
 *  (run-before-swap on the server — nothing is cleared up front). */
export function WidgetEditModal({ dashboardId, widgetId, oldSql, onClose, onEdited }: {
  dashboardId: string;
  widgetId: string;
  /** Current SQL from the owner page (already available there for the 📅 badge). */
  oldSql: string;
  onClose: () => void;
  onEdited: (widgetId: string) => void;
}) {
  const [instruction, setInstruction] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [proposal, setProposal] = useState<Proposal | null>(null);
  const [confirmRisk, setConfirmRisk] = useState<string | null>(null);

  async function propose() {
    if (!instruction.trim()) return;
    setBusy(true); setError(''); setProposal(null);
    try {
      const r = await fetch(`/api/dashboards/${dashboardId}/widgets/${widgetId}/edit`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ instruction }),
      });
      const d = await r.json();
      if (!d.ok) { setError(d.error); return; }
      setProposal(d.proposal);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'request failed');
    } finally {
      setBusy(false);
    }
  }

  async function apply(confirmed = false) {
    if (!proposal) return;
    setBusy(true); setError('');
    try {
      const r = await fetch(`/api/dashboards/${dashboardId}/widgets/${widgetId}/edit`, {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sql: proposal.sql, chartSpec: proposal.chartSpec ?? undefined, title: proposal.title, confirmed }),
      });
      const d = await r.json();
      if (d.status === 'needs_confirmation') { setConfirmRisk(d.risk?.reason ?? 'medium risk'); return; }
      if (d.status !== 'ok') { setError(d.message ?? 'apply failed'); return; }
      onEdited(widgetId);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'request failed');
    } finally {
      setBusy(false);
    }
  }

  const sqlBox = 'block max-h-40 overflow-auto whitespace-pre rounded bg-neutral-50 p-2 text-[11px] text-neutral-700 dark:bg-neutral-950 dark:text-neutral-300';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div className="max-h-[85vh] w-full max-w-2xl overflow-auto rounded-lg bg-white p-5 shadow-xl dark:bg-neutral-900" onClick={(e) => e.stopPropagation()} data-testid="widget-edit-modal">
        <h2 className="mb-3 text-base font-semibold">✏️ Edit widget with AI</h2>

        {!proposal ? (
          <div className="space-y-3">
            <label className="block text-sm">What should change?
              <textarea value={instruction} onChange={(e) => setInstruction(e.target.value)} rows={2}
                placeholder='e.g. "only the top 10" · "add a filter segment = Consumer" · "group by quarter instead"'
                className="mt-1 block w-full rounded border p-2 text-sm dark:bg-neutral-900" data-testid="edit-instruction" />
            </label>
            {error && <p className="text-xs text-red-600" data-testid="edit-error">{error}</p>}
            <div className="flex justify-end gap-2">
              <button onClick={onClose} className="rounded border px-3 py-1 text-sm">Cancel</button>
              <button onClick={propose} disabled={busy || !instruction.trim()} className="rounded bg-blue-600 px-3 py-1 text-sm text-white disabled:opacity-40" data-testid="edit-propose">
                {busy ? 'Thinking…' : 'Propose edit'}
              </button>
            </div>
          </div>
        ) : (
          <div className="space-y-3 text-sm">
            {proposal.rationale && <p className="text-neutral-500">{proposal.rationale}</p>}
            {proposal.title && <p>New title: <b>{proposal.title}</b></p>}
            <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
              <div><p className="mb-1 text-xs text-neutral-500">Current SQL</p><code className={sqlBox}>{oldSql}</code></div>
              <div><p className="mb-1 text-xs text-neutral-500">Proposed SQL</p><code className={sqlBox} data-testid="edit-new-sql">{proposal.sql}</code></div>
            </div>
            <p className="text-xs">
              {proposal.probe.ok
                ? <span className="text-green-600">✓ {proposal.probe.dryRun ? 'validated (dry-run)' : `runs OK — ${proposal.probe.rowCount} rows`}</span>
                : <span className="text-amber-600" data-testid="edit-probe-fail">⊘ {proposal.probe.error}</span>}
            </p>
            {proposal.warnings.map((wng, i) => <p key={i} className="rounded bg-amber-50 p-2 text-xs text-amber-700 dark:bg-amber-950/30 dark:text-amber-400" data-testid="edit-warning">⚠ {wng}</p>)}
            {confirmRisk && (
              <div className="rounded border border-amber-300 bg-amber-50 p-2 text-xs text-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
                ⚠ Medium-risk ({confirmRisk}). <button onClick={() => apply(true)} disabled={busy} className="underline" data-testid="edit-confirm-apply">Confirm & apply</button>
              </div>
            )}
            {error && <p className="text-xs text-red-600" data-testid="edit-error">{error}</p>}
            <div className="flex justify-end gap-2">
              <button onClick={() => { setProposal(null); setConfirmRisk(null); setError(''); }} className="rounded border px-3 py-1 text-sm">← Back</button>
              <button onClick={() => apply(false)} disabled={busy || !proposal.probe.ok || !!confirmRisk}
                className="rounded bg-blue-600 px-3 py-1 text-sm text-white disabled:opacity-40" data-testid="edit-apply">
                {busy ? 'Applying…' : 'Accept'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
