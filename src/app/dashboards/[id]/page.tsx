'use client';

import { use, useEffect, useState, useCallback } from 'react';
import Link from 'next/link';
import { DashboardWidget, type WidgetData } from '../../../components/dashboard-widget';
import { FormModal } from '../../../components/form-modal';
import { hasDateRangePlaceholders, isValidIsoDate } from '../../../lib/sql-param';

interface DashDetail { id: string; name: string; shareSlug: string | null; widgets: (WidgetData & { sql?: string })[] }

/** Preset → {from,to} (ISO). Computed client-side at click time. */
function presetRange(preset: '7d' | '30d' | '90d' | 'ytd'): { from: string; to: string } {
  const now = new Date();
  const to = now.toISOString().slice(0, 10);
  if (preset === 'ytd') return { from: `${now.getUTCFullYear()}-01-01`, to };
  const days = preset === '7d' ? 7 : preset === '30d' ? 30 : 90;
  return { from: new Date(now.getTime() - days * 24 * 3600 * 1000).toISOString().slice(0, 10), to };
}

// Layout width per widget size (6-col grid): s=1/3, m=1/2, l=full.
const SIZE_CLS: Record<string, string> = { s: 'md:col-span-2', m: 'md:col-span-3', l: 'md:col-span-6' };

export default function DashboardDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [dash, setDash] = useState<DashDetail | null>(null);
  // Auto-refresh schedule (max 1 per dashboard, stored under the first widget's
  // connection — the schedules API is connection-scoped).
  const [refreshSched, setRefreshSched] = useState<{ id: string; cron: string } | null>(null);
  const [schedModal, setSchedModal] = useState(false);
  const [shareMsg, setShareMsg] = useState('');
  // Dashboard date range: view-state only (never persisted — reload returns to
  // the cached default-range results). Transient results keyed by widget id.
  const [range, setRange] = useState({ from: '', to: '' });
  const [rangeResults, setRangeResults] = useState<Record<string, { columns: string[]; rows: unknown[][] }>>({});
  const [rangeMsg, setRangeMsg] = useState('');
  // Cross-filters: view-state only, same as date-range. Each carries the source
  // widget so it is never re-applied to the widget that produced it. A monotonic
  // generation guards against a slow earlier response overwriting a newer one.
  const [crossFilters, setCrossFilters] = useState<{ column: string; value: string | number | boolean | null; label: string; sourceWidgetId: string }[]>([]);
  const [filterResults, setFilterResults] = useState<Record<string, { columns: string[]; rows: unknown[][]; filtered: boolean; reason?: string }>>({});
  const [filterGen, setFilterGen] = useState(0);

  const load = useCallback(async () => {
    const r = await fetch(`/api/dashboards/${id}`);
    if (!r.ok) return;
    const d: DashDetail = await r.json();
    setDash(d);
    const connId = (d.widgets?.[0] as { connectionId?: string } | undefined)?.connectionId;
    if (connId) {
      fetch(`/api/connections/${connId}/schedules`).then((x) => x.json()).then((list: { id: string; mode: string; targetId: string | null; cron: string }[]) => {
        const found = list.find((sc) => sc.mode === 'dashboard_refresh' && sc.targetId === d.id);
        setRefreshSched(found ? { id: found.id, cron: found.cron } : null);
      }).catch(() => {});
    }
  }, [id]);
  useEffect(() => { load(); }, [load]);

  async function toggleShare(enable: boolean) {
    const r = await fetch(`/api/dashboards/${id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ share: enable }) });
    const d = await r.json();
    setShareMsg(d.shareSlug ? `${location.origin}/share/dashboard/${d.shareSlug}` : 'sharing off');
    load();
  }

  async function refreshAll() {
    if (!dash) return;
    await Promise.allSettled(dash.widgets.map((w) => fetch(`/api/dashboards/${id}/widgets/${w.id}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })));
    load();
  }

  if (!dash) return <main className="p-6 text-sm text-neutral-500">Loading…</main>;


  async function saveRefreshSchedule(cronExpr: string) {
    const connId = (dash?.widgets?.[0] as { connectionId?: string } | undefined)?.connectionId;
    if (!dash || !connId) return;
    // create-or-replace: one refresh schedule per dashboard
    if (refreshSched) {
      await fetch(`/api/connections/${connId}/schedules`, { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ scheduleId: refreshSched.id }) });
    }
    const r = await fetch(`/api/connections/${connId}/schedules`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'create', name: `Auto-refresh: ${dash.name}`, mode: 'dashboard_refresh', targetId: dash.id, cron: cronExpr }),
    });
    const d = await r.json();
    setRefreshSched(r.ok ? { id: d.id, cron: cronExpr } : refreshSched);
  }

  async function removeRefreshSchedule() {
    const connId = (dash?.widgets?.[0] as { connectionId?: string } | undefined)?.connectionId;
    if (!refreshSched || !connId) return;
    await fetch(`/api/connections/${connId}/schedules`, { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ scheduleId: refreshSched.id }) });
    setRefreshSched(null);
  }

  /** Run all {{from}}/{{to}} widgets with the given range, transiently. */
  async function applyRange(r: { from: string; to: string }) {
    if (!dash) return;
    setRange(r);
    setRangeMsg('');
    if (!isValidIsoDate(r.from) || !isValidIsoDate(r.to)) { setRangeMsg('Dates must be YYYY-MM-DD'); return; }
    const targets = dash.widgets.filter((w) => w.sql && hasDateRangePlaceholders(w.sql));
    if (targets.length === 0) { setRangeMsg('No widget uses {{from}}/{{to}} — add the placeholders to a widget SQL to make it range-aware.'); return; }
    const next: Record<string, { columns: string[]; rows: unknown[][] }> = {};
    await Promise.allSettled(targets.map(async (w) => {
      const res = await fetch(`/api/dashboards/${id}/widgets/${w.id}`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ from: r.from, to: r.to }),
      });
      const d = await res.json();
      if (d.status === 'ok') next[w.id] = { columns: d.columns, rows: d.rows };
    }));
    setRangeResults(next);
  }

  function clearRange() {
    setRange({ from: '', to: '' });
    setRangeResults({});
    setRangeMsg('');
  }

  /** Re-run every widget EXCEPT the ones a filter came from, applying the given
   *  cross-filter set transiently. A generation token drops stale responses.
   *  Plain function (not a hook) — it runs on click, never in a dependency array,
   *  and lives below the loading early-return. */
  async function runCrossFilters(filters: typeof crossFilters) {
    if (!dash) return;
    const gen = filterGen + 1;
    setFilterGen(gen);
    if (filters.length === 0) { setFilterResults({}); return; }
    const payload = filters.map((f) => ({ column: f.column, value: f.value }));
    const sourceIds = new Set(filters.map((f) => f.sourceWidgetId));
    const targets = dash.widgets.filter((w) => !sourceIds.has(w.id));
    const next: Record<string, { columns: string[]; rows: unknown[][]; filtered: boolean; reason?: string }> = {};
    await Promise.allSettled(targets.map(async (w) => {
      const res = await fetch(`/api/dashboards/${id}/widgets/${w.id}`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ crossFilters: payload, ...(range.from && range.to ? { from: range.from, to: range.to } : {}) }),
      });
      const d = await res.json();
      if (d.status === 'ok') next[w.id] = { columns: d.columns, rows: d.rows, filtered: d.filtered !== false, reason: d.filterReason };
      else next[w.id] = { columns: [], rows: [], filtered: false, reason: d.message };
    }));
    // Ignore if a newer apply started while we awaited.
    setFilterGen((cur) => {
      if (cur === gen) setFilterResults(next);
      return cur;
    });
  }

  /** A datapoint was clicked in a widget → add/replace the filter for that column
   *  (one filter per column) and re-run siblings. Coerces the raw cell value to a
   *  filter primitive; a Date/object becomes its string form for the SQL literal. */
  function addCrossFilter(sourceWidgetId: string, column: string, raw: unknown) {
    const value: string | number | boolean | null =
      raw === null || raw === undefined ? null
      : typeof raw === 'number' || typeof raw === 'boolean' ? raw
      : typeof raw === 'string' ? raw
      : String(raw);
    const label = `${column} = ${value === null ? 'NULL' : String(value)}`;
    const next = [...crossFilters.filter((f) => f.column !== column), { column, value, label, sourceWidgetId }];
    setCrossFilters(next);
    runCrossFilters(next);
  }

  function removeCrossFilter(column: string) {
    const next = crossFilters.filter((f) => f.column !== column);
    setCrossFilters(next);
    runCrossFilters(next);
  }

  function clearCrossFilters() {
    setCrossFilters([]);
    setFilterResults({});
  }

  async function setLayout(widgetId: string, patch: { size?: string; position?: number }) {
    await fetch(`/api/dashboards/${id}/widgets/${widgetId}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(patch) });
    load();
  }

  /** Swap the position of two adjacent widgets (indices in the rendered order). */
  async function swapOrder(a: number, b: number) {
    if (!dash || b < 0 || b >= dash.widgets.length) return;
    const wa = dash.widgets[a], wb = dash.widgets[b];
    // Positions may collide (legacy default 0) — normalize to index-based order.
    await Promise.all([
      fetch(`/api/dashboards/${id}/widgets/${wa.id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ position: b }) }),
      fetch(`/api/dashboards/${id}/widgets/${wb.id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ position: a }) }),
    ]);
    load();
  }

  return (
    <main className="mx-auto max-w-5xl p-6">
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-lg font-semibold">{dash.name}</h1>
        <div className="flex items-center gap-3 text-sm">
          <button onClick={refreshAll} className="text-blue-600">Refresh all</button>
          <button onClick={() => setSchedModal(true)} disabled={!dash.widgets.length} className="text-blue-600 disabled:opacity-40" title={dash.widgets.length ? 'Refresh on a cron schedule' : 'Pin a widget first'}>
            ⏰ Auto-refresh{refreshSched ? ' (on)' : ''}</button>
          <button onClick={() => toggleShare(!dash.shareSlug)} className="text-blue-600">{dash.shareSlug ? 'Regenerate share link' : 'Share'}</button>
          {dash.shareSlug && <button onClick={() => toggleShare(false)} className="text-red-600">Unshare</button>}
          <Link href="/dashboards" className="text-blue-600">← Dashboards</Link>
        </div>
      </div>
      {shareMsg && <p className="mb-3 break-all rounded bg-green-50 p-2 text-xs text-green-700 dark:bg-green-950/40 dark:text-green-300">{shareMsg}</p>}
      {dash.widgets.length > 0 && (
        <div className="mb-4 flex flex-wrap items-center gap-2 rounded border border-neutral-200 p-2 text-xs dark:border-neutral-800" data-testid="daterange-control">
          <span className="text-neutral-500">📅 Date range</span>
          {(['7d', '30d', '90d', 'ytd'] as const).map((p) => (
            <button key={p} onClick={() => applyRange(presetRange(p))} className="rounded border px-2 py-0.5 hover:bg-neutral-100 dark:hover:bg-neutral-800">{p.toUpperCase()}</button>
          ))}
          <input value={range.from} onChange={(e) => setRange({ ...range, from: e.target.value })} placeholder="from YYYY-MM-DD" className="w-32 rounded border p-1 font-mono dark:bg-neutral-900" data-testid="range-from" />
          <input value={range.to} onChange={(e) => setRange({ ...range, to: e.target.value })} placeholder="to YYYY-MM-DD" className="w-32 rounded border p-1 font-mono dark:bg-neutral-900" data-testid="range-to" />
          <button onClick={() => applyRange(range)} className="rounded bg-blue-600 px-2 py-0.5 text-white" data-testid="range-apply">Apply</button>
          {Object.keys(rangeResults).length > 0 && <button onClick={clearRange} className="text-blue-600 hover:underline">Reset to default (30d cache)</button>}
          {rangeMsg && <span className="text-amber-600">{rangeMsg}</span>}
        </div>
      )}
      {crossFilters.length > 0 && (
        <div className="mb-4 flex flex-wrap items-center gap-2 rounded border border-blue-200 bg-blue-50/50 p-2 text-xs dark:border-blue-900 dark:bg-blue-950/20" data-testid="crossfilter-bar">
          <span className="text-blue-600 dark:text-blue-400">🔎 Cross-filter</span>
          {crossFilters.map((f) => (
            <button key={f.column} onClick={() => removeCrossFilter(f.column)}
              className="rounded-full border border-blue-300 bg-white px-2 py-0.5 hover:bg-blue-100 dark:border-blue-800 dark:bg-neutral-900" title="Remove this filter">
              {f.label} ✕
            </button>
          ))}
          <button onClick={clearCrossFilters} className="text-blue-600 hover:underline">Clear all</button>
          <span className="text-neutral-400">· click a bar or slice to filter; view only, not saved</span>
        </div>
      )}
      {dash.widgets.length === 0 ? (
        <p className="text-sm text-neutral-500">No widgets. Pin a result from chat (📌 Pin to dashboard).</p>
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-6">
          {dash.widgets.map((w, i) => (
            <div key={w.id} className={SIZE_CLS[(w as { size?: string }).size ?? 'm'] ?? SIZE_CLS.m}>
              <div className="mb-1 flex items-center justify-end gap-1 text-[11px] text-neutral-400" data-testid="widget-layout-controls">
                {(['s', 'm', 'l'] as const).map((sz) => (
                  <button key={sz} onClick={() => setLayout(w.id, { size: sz })}
                    className={((w as { size?: string }).size ?? 'm') === sz ? 'font-bold text-blue-600' : 'hover:text-neutral-600'}>{sz.toUpperCase()}</button>
                ))}
                <button onClick={() => swapOrder(i, i - 1)} disabled={i === 0} className="disabled:opacity-30" title="Move up">↑</button>
                <button onClick={() => swapOrder(i, i + 1)} disabled={i === dash.widgets.length - 1} className="disabled:opacity-30" title="Move down">↓</button>
              </div>
              <DashboardWidget widget={w} dashboardId={id} onChanged={load}
                overrideResult={filterResults[w.id] ?? rangeResults[w.id] ?? null}
                crossFilterState={crossFilters.length > 0 ? { active: true, filtered: filterResults[w.id]?.filtered ?? true, reason: filterResults[w.id]?.reason } : null}
                onDatumClick={(column, value) => addCrossFilter(w.id, column, value)}
                parametrized={!!w.sql && hasDateRangePlaceholders(w.sql)} />
            </div>
          ))}
        </div>
      )}
          {schedModal && (
        <FormModal open title="Auto-refresh dashboard on a schedule" submitLabel={refreshSched ? 'Update schedule' : 'Create schedule'}
          fields={[{ name: 'cron', label: 'Cron (5 fields — e.g. 0 7 * * * = daily 07:00)', defaultValue: refreshSched?.cron ?? '0 7 * * *', required: true, mono: true }]}
          onSubmit={(v) => { setSchedModal(false); saveRefreshSchedule(v.cron.trim()); }} onClose={() => setSchedModal(false)} />
      )}
      {refreshSched && <p className="mt-2 text-xs text-neutral-400">Auto-refresh: <span className="font-mono">{refreshSched.cron}</span> · <button onClick={removeRefreshSchedule} className="text-red-600 hover:underline">turn off</button> <span title="Xoá connection của widget đầu tiên sẽ xoá lịch này">ⓘ</span></p>}
    </main>
  );
}
