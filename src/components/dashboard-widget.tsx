'use client';

import { useState } from 'react';
import { ResultTable } from './result-table';
import { ResultChart } from './result-chart';
import { validateChartSpec } from '../services/chart-spec-service';

export interface WidgetData {
  id: string;
  title: string;
  connectionId?: string;
  chartSpec?: unknown;
  lastResult?: { columns: string[]; rows: unknown[][] } | null;
  lastRefreshedAt?: string | null;
}

/**
 * Renders one dashboard widget from its cached result. `readOnly` (share view)
 * hides the owner controls. chartSpec is validated on READ (red-team M2) so a
 * malformed stored spec falls back to the table instead of breaking the render.
 */
export function DashboardWidget({
  widget,
  dashboardId,
  readOnly = false,
  onChanged,
  overrideResult,
  parametrized = false,
}: {
  widget: WidgetData;
  dashboardId?: string;
  readOnly?: boolean;
  onChanged?: () => void;
  /** Transient result from a dashboard date-range run — rendered instead of the
   *  cache, never persisted (the share view must keep the default-range cache). */
  overrideResult?: { columns: string[]; rows: unknown[][] } | null;
  /** Widget SQL contains {{from}}/{{to}} — shows the 📅 responds-to-range badge. */
  parametrized?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [confirm, setConfirm] = useState<{ reason: string } | undefined>();

  const result = overrideResult ?? widget.lastResult;
  const validSpec = validateChartSpec(widget.chartSpec); // M2: validate on read
  const showChart = !!validSpec && !!result && result.rows.length > 0;

  async function refresh(confirmed = false) {
    if (!dashboardId) return;
    setBusy(true); setMsg(''); setConfirm(undefined);
    const r = await fetch(`/api/dashboards/${dashboardId}/widgets/${widget.id}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ confirmed }),
    });
    const d = await r.json();
    if (d.status === 'needs_confirmation') setConfirm({ reason: d.risk?.reason ?? 'medium risk' });
    else if (d.status !== 'ok') setMsg(d.message ?? 'error');
    setBusy(false);
    if (d.status === 'ok') onChanged?.();
  }

  async function remove() {
    if (!dashboardId || !confirmDelete()) return;
    await fetch(`/api/dashboards/${dashboardId}/widgets/${widget.id}`, { method: 'DELETE' });
    onChanged?.();
  }

  return (
    <div className="rounded-lg border border-neutral-200 p-3 dark:border-neutral-800">
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-sm font-medium">{widget.title}{parametrized && <span className="ml-1" title="Responds to the dashboard date range ({{from}}/{{to}})">📅</span>}</h3>
        {!readOnly && dashboardId && (
          <div className="flex items-center gap-2 text-xs">
            <button onClick={() => refresh(false)} disabled={busy} className="text-blue-600 disabled:opacity-40">{busy ? '…' : 'Refresh'}</button>
            <button onClick={remove} className="text-red-600">Remove</button>
          </div>
        )}
      </div>
      {confirm && (
        <div className="mb-2 rounded border border-amber-300 bg-amber-50 p-2 text-xs text-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
          ⚠ Medium-risk ({confirm.reason}).{' '}
          <button onClick={() => refresh(true)} className="underline">Confirm & refresh</button>
        </div>
      )}
      {msg && <p className="mb-1 text-xs text-red-600">{msg}</p>}
      {!result ? (
        <p className="text-xs text-neutral-500">{readOnly ? 'No data yet — the owner hasn’t refreshed this widget.' : 'Not run yet — click Refresh.'}</p>
      ) : showChart ? (
        <ResultChart columns={result.columns} rows={result.rows} />
      ) : (
        <ResultTable columns={result.columns} rows={result.rows} />
      )}
      {overrideResult ? (
        <p className="mt-1 text-[10px] text-amber-600" data-testid="range-transient-note">Custom range view — not saved (share keeps the default range)</p>
      ) : widget.lastRefreshedAt && (
        <p className="mt-1 text-[10px] text-neutral-400">Last refreshed {new Date(widget.lastRefreshedAt).toLocaleString()}</p>
      )}
    </div>
  );
}

function confirmDelete(): boolean {
  return typeof window !== 'undefined' && window.confirm('Remove this widget?');
}
