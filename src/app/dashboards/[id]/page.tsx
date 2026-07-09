'use client';

import { use, useEffect, useState, useCallback } from 'react';
import Link from 'next/link';
import { DashboardWidget, type WidgetData } from '../../../components/dashboard-widget';

interface DashDetail { id: string; name: string; shareSlug: string | null; widgets: WidgetData[] }

export default function DashboardDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [dash, setDash] = useState<DashDetail | null>(null);
  const [shareMsg, setShareMsg] = useState('');

  const load = useCallback(async () => {
    const r = await fetch(`/api/dashboards/${id}`);
    if (r.ok) setDash(await r.json());
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

  return (
    <main className="mx-auto max-w-5xl p-6">
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-lg font-semibold">{dash.name}</h1>
        <div className="flex items-center gap-3 text-sm">
          <button onClick={refreshAll} className="text-blue-600">Refresh all</button>
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
    </main>
  );
}
