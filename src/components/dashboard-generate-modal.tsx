'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';

interface ProposedWidget {
  title: string;
  sql: string;
  chartSpec: unknown | null;
  rationale?: string;
  fromMetricId?: string;
  probe: { ok: boolean; rowCount?: number; dryRun?: boolean; error?: string };
}

/** Two-step modal: prompt → probed proposal with per-widget checkboxes → create.
 *  Probed-OK widgets are checked by default; failed ones are shown disabled with
 *  their reason. `existingDashboardId` switches to iterate (append) mode. */
export function DashboardGenerateModal({ connections, existingDashboardId, existingConnectionId, onClose }: {
  connections: { id: string; name: string }[];
  existingDashboardId?: string;
  existingConnectionId?: string;
  onClose: () => void;
}) {
  const router = useRouter();
  const [connectionId, setConnectionId] = useState(existingConnectionId ?? connections[0]?.id ?? '');
  const [prompt, setPrompt] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [proposal, setProposal] = useState<{ dashboardTitle: string; widgets: ProposedWidget[] } | null>(null);
  const [checked, setChecked] = useState<boolean[]>([]);

  useEffect(() => {
    if (proposal) setChecked(proposal.widgets.map((w) => w.probe.ok));
  }, [proposal]);

  async function generate() {
    if (!prompt.trim() || !connectionId) return;
    setBusy(true); setError(''); setProposal(null);
    // Iterate mode: give the model the SAME-connection existing widgets so it
    // proposes only new, non-duplicate ones (never leak another connection's SQL).
    let existingWidgets: { title: string; sql: string }[] | undefined;
    if (existingDashboardId) {
      const dash = await fetch(`/api/dashboards/${existingDashboardId}`).then((x) => x.json()).catch(() => null);
      existingWidgets = (dash?.widgets ?? [])
        .filter((w: { connectionId?: string; sql?: string }) => w.connectionId === connectionId && typeof w.sql === 'string')
        .map((w: { title: string; sql: string }) => ({ title: w.title, sql: w.sql }));
    }
    const r = await fetch(`/api/connections/${connectionId}/generate-dashboard`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt, existingWidgets }),
    });
    const d = await r.json();
    setBusy(false);
    if (!d.ok) { setError(d.error + (d.details ? ` (${d.details})` : '')); return; }
    setProposal({ dashboardTitle: d.dashboardTitle, widgets: d.widgets });
  }

  const selectedCount = checked.filter(Boolean).length;

  async function create() {
    if (!proposal || selectedCount === 0) return;
    setBusy(true); setError('');
    const widgets = proposal.widgets.filter((_, i) => checked[i]).map((w) => ({ title: w.title, sql: w.sql, chartSpec: w.chartSpec }));
    const r = await fetch('/api/dashboards/generate-accept', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ connectionId, dashboardTitle: proposal.dashboardTitle, existingDashboardId, widgets }),
    });
    const d = await r.json();
    setBusy(false);
    if (!d.ok) { setError(d.error); return; }
    onClose();
    router.push(`/dashboards/${d.dashboardId}`);
    router.refresh();
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div className="max-h-[85vh] w-full max-w-2xl overflow-auto rounded-lg bg-white p-5 shadow-xl dark:bg-neutral-900" onClick={(e) => e.stopPropagation()} data-testid="generate-dashboard-modal">
        <h2 className="mb-3 text-base font-semibold">✨ {existingDashboardId ? 'Add widgets with AI' : 'Generate a dashboard'}</h2>

        {!proposal ? (
          <div className="space-y-3">
            {!existingConnectionId && (
              <label className="block text-sm">Connection
                <select value={connectionId} onChange={(e) => setConnectionId(e.target.value)} className="mt-1 block w-full rounded border p-2 text-sm dark:bg-neutral-900" data-testid="generate-connection">
                  {connections.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              </label>
            )}
            <label className="block text-sm">What should this dashboard show?
              <textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} rows={3}
                placeholder="e.g. Revenue and order overview by month and customer segment"
                className="mt-1 block w-full rounded border p-2 text-sm dark:bg-neutral-900" data-testid="generate-prompt" />
            </label>
            {error && <p className="text-xs text-red-600" data-testid="generate-error">{error}</p>}
            <div className="flex justify-end gap-2">
              <button onClick={onClose} className="rounded border px-3 py-1 text-sm">Cancel</button>
              <button onClick={generate} disabled={busy || !prompt.trim()} className="rounded bg-blue-600 px-3 py-1 text-sm text-white disabled:opacity-40" data-testid="generate-submit">
                {busy ? 'Generating…' : 'Generate'}
              </button>
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            <p className="text-sm text-neutral-500">Proposed: <b>{proposal.dashboardTitle}</b> — pick the widgets to keep.</p>
            <ul className="space-y-2" data-testid="proposal-list">
              {proposal.widgets.map((w, i) => (
                <li key={i} className={`rounded border p-2 text-sm ${w.probe.ok ? 'border-neutral-200 dark:border-neutral-800' : 'border-amber-300 bg-amber-50/50 dark:border-amber-900 dark:bg-amber-950/20'}`}>
                  <label className="flex items-start gap-2">
                    <input type="checkbox" disabled={!w.probe.ok} checked={checked[i] ?? false}
                      onChange={(e) => setChecked((c) => c.map((v, j) => (j === i ? e.target.checked : v)))}
                      className="mt-1" data-testid={`widget-check-${i}`} />
                    <span className="min-w-0 flex-1">
                      <span className="font-medium">{w.title}</span>
                      {w.fromMetricId && <span className="ml-1 rounded bg-blue-100 px-1 text-[10px] text-blue-700 dark:bg-blue-950/50 dark:text-blue-300">governed metric</span>}
                      {w.probe.ok
                        ? <span className="ml-1 text-[10px] text-green-600">✓ {w.probe.dryRun ? 'validated (dry-run)' : `${w.probe.rowCount} rows`}</span>
                        : <span className="ml-1 text-[10px] text-amber-600">⊘ {w.probe.error}</span>}
                      {w.rationale && <span className="block text-[11px] text-neutral-500">{w.rationale}</span>}
                      <code className="mt-1 block overflow-x-auto whitespace-pre rounded bg-neutral-50 p-1 text-[10px] text-neutral-600 dark:bg-neutral-950 dark:text-neutral-400">{w.sql}</code>
                    </span>
                  </label>
                </li>
              ))}
            </ul>
            {error && <p className="text-xs text-red-600" data-testid="generate-error">{error}</p>}
            <div className="flex justify-end gap-2">
              <button onClick={() => setProposal(null)} className="rounded border px-3 py-1 text-sm">← Back</button>
              <button onClick={create} disabled={busy || selectedCount === 0} className="rounded bg-blue-600 px-3 py-1 text-sm text-white disabled:opacity-40" data-testid="create-dashboard-submit">
                {busy ? 'Creating…' : `${existingDashboardId ? 'Add' : 'Create dashboard'} (${selectedCount})`}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
