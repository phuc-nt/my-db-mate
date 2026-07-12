'use client';

import { use, useEffect, useState, useCallback } from 'react';
import Link from 'next/link';
import { DashboardWidget, type WidgetData } from '../../../components/dashboard-widget';
import { FormModal } from '../../../components/form-modal';

interface DashDetail { id: string; name: string; shareSlug: string | null; widgets: WidgetData[] }

export default function DashboardDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [dash, setDash] = useState<DashDetail | null>(null);
  // Auto-refresh schedule (max 1 per dashboard, stored under the first widget's
  // connection — the schedules API is connection-scoped).
  const [refreshSched, setRefreshSched] = useState<{ id: string; cron: string } | null>(null);
  const [schedModal, setSchedModal] = useState(false);
  const [shareMsg, setShareMsg] = useState('');

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
      {dash.widgets.length === 0 ? (
        <p className="text-sm text-neutral-500">No widgets. Pin a result from chat (📌 Pin to dashboard).</p>
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          {dash.widgets.map((w) => (
            <DashboardWidget key={w.id} widget={w} dashboardId={id} onChanged={load} />
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
