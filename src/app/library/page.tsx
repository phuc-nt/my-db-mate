'use client';

import { Suspense, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { NewDashboardForm, NewReportForm } from '../../components/new-output-forms';
import { DashboardGenerateModal } from '../../components/dashboard-generate-modal';

/** Unified outputs list: dashboards + reports + notebooks in one place, filterable
 *  by type and connection. Detail pages keep their original URLs — this only
 *  replaces the three separate list pages. */

type ItemType = 'dashboard' | 'report' | 'notebook';
interface Item {
  type: ItemType;
  id: string;
  title: string;
  href: string;
  shared: boolean;
  connections: string[];
  at: string; // updatedAt (or createdAt fallback) for sorting
}

const TYPE_META: Record<ItemType, { icon: string; label: string }> = {
  dashboard: { icon: '📊', label: 'Dashboard' },
  report: { icon: '📝', label: 'Report' },
  notebook: { icon: '📓', label: 'Notebook' },
};

function LibraryInner() {
  const initialType = useSearchParams().get('type');
  const [items, setItems] = useState<Item[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [type, setType] = useState<'all' | ItemType>(
    initialType === 'dashboard' || initialType === 'report' || initialType === 'notebook' ? initialType : 'all');
  const [conn, setConn] = useState('all');
  const [q, setQ] = useState('');
  const [showForm, setShowForm] = useState<'dashboard' | 'report' | null>(null);
  const [showGenerate, setShowGenerate] = useState(false);
  const [conns, setConns] = useState<{ id: string; name: string }[]>([]);

  async function load() {
    const [ds, rs, ns] = await Promise.all([
      fetch('/api/dashboards').then((r) => r.json()),
      fetch('/api/reports').then((r) => r.json()),
      fetch('/api/notebooks').then((r) => r.json()),
    ]);
    const merged: Item[] = [
      ...(ds as { id: string; name: string; shareSlug: string | null; connectionNames?: string[]; updatedAt: string; createdAt: string }[])
        .map((d) => ({ type: 'dashboard' as const, id: d.id, title: d.name, href: `/dashboards/${d.id}`, shared: !!d.shareSlug, connections: d.connectionNames ?? [], at: d.updatedAt ?? d.createdAt })),
      ...(rs as { id: string; title: string; shareSlug: string | null; connectionNames?: string[]; updatedAt: string; createdAt: string }[])
        .map((r) => ({ type: 'report' as const, id: r.id, title: r.title, href: `/reports/${r.id}`, shared: !!r.shareSlug, connections: r.connectionNames ?? [], at: r.updatedAt ?? r.createdAt })),
      ...(ns as { id: string; title: string; shareSlug: string | null; connectionName?: string | null; createdAt: string }[])
        .map((n) => ({ type: 'notebook' as const, id: n.id, title: n.title, href: `/notebooks/${n.id}`, shared: !!n.shareSlug, connections: n.connectionName ? [n.connectionName] : [], at: n.createdAt })),
    ].sort((a, b) => (a.at < b.at ? 1 : -1));
    setItems(merged);
    setLoaded(true);
  }
  useEffect(() => { load(); }, []);
  useEffect(() => { fetch('/api/connections').then((r) => r.json()).then((cs: { id: string; name: string }[]) => setConns(cs)).catch(() => {}); }, []);

  const connOptions = useMemo(() => [...new Set(items.flatMap((i) => i.connections))].sort(), [items]);
  const shown = items.filter((i) =>
    (type === 'all' || i.type === type) &&
    (conn === 'all' || i.connections.includes(conn)) &&
    (!q.trim() || i.title.toLowerCase().includes(q.trim().toLowerCase())));

  return (
    <main className="mx-auto max-w-3xl p-6">
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-lg font-semibold">Library</h1>
        <div className="flex gap-2 text-sm">
          <button onClick={() => setShowGenerate(true)} disabled={conns.length === 0} className="rounded border border-blue-300 px-3 py-1 text-blue-600 hover:bg-blue-50 disabled:opacity-40 dark:border-blue-800 dark:hover:bg-blue-950/30" data-testid="generate-dashboard-open">✨ Generate dashboard</button>
          <button onClick={() => setShowForm(showForm === 'dashboard' ? null : 'dashboard')} className="rounded border px-3 py-1 hover:bg-neutral-100 dark:hover:bg-neutral-800">+ Dashboard</button>
          <button onClick={() => setShowForm(showForm === 'report' ? null : 'report')} className="rounded border px-3 py-1 hover:bg-neutral-100 dark:hover:bg-neutral-800">+ Report</button>
        </div>
      </div>

      {showGenerate && <DashboardGenerateModal connections={conns} onClose={() => { setShowGenerate(false); load(); }} />}
      {showForm === 'dashboard' && <NewDashboardForm onCreated={() => { setShowForm(null); load(); }} />}
      {showForm === 'report' && <NewReportForm onCreated={() => { setShowForm(null); load(); }} />}

      <div className="mb-4 flex flex-wrap items-center gap-2 text-sm">
        {(['all', 'dashboard', 'report', 'notebook'] as const).map((t) => (
          <button key={t} onClick={() => setType(t)}
            className={`rounded px-2 py-1 text-xs ${type === t ? 'bg-blue-600 text-white' : 'text-neutral-600 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-800'}`}>
            {t === 'all' ? 'All' : TYPE_META[t].label + 's'}
          </button>
        ))}
        <select value={conn} onChange={(e) => setConn(e.target.value)} className="rounded border p-1 text-xs dark:bg-neutral-900">
          <option value="all">All connections</option>
          {connOptions.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search…" className="min-w-32 flex-1 rounded border p-1 text-xs dark:bg-neutral-900" />
      </div>

      <ul className="space-y-2">
        {!loaded && <li className="text-sm text-neutral-400">Loading…</li>}
        {loaded && shown.length === 0 && (
          <li className="rounded border border-dashed border-neutral-200 p-4 text-sm text-neutral-500 dark:border-neutral-800">
            Nothing here yet. Outputs are born in Chat — <b>📌 Pin to dashboard</b>, <b>Save as notebook</b> — or create a dashboard/report above.{' '}
            <Link href="/connections" className="text-blue-600">Open a connection →</Link>
          </li>
        )}
        {shown.map((i) => (
          <li key={`${i.type}-${i.id}`} className="flex items-center justify-between gap-3 rounded border border-neutral-200 p-3 dark:border-neutral-800">
            <div className="min-w-0">
              <Link href={i.href} className="font-medium text-blue-600">{TYPE_META[i.type].icon} {i.title}</Link>
              <div className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-neutral-500">
                <span>{TYPE_META[i.type].label}</span>
                {i.connections.length === 1 && <span>· {i.connections[0]}</span>}
                {i.connections.length > 1 && <span>· {i.connections.length} connections</span>}
              </div>
            </div>
            {i.shared && <span className="shrink-0 text-xs text-green-600">shared</span>}
          </li>
        ))}
      </ul>
    </main>
  );
}

export default function LibraryPage() {
  return <Suspense fallback={<main className="p-6 text-sm text-neutral-400">Loading…</main>}><LibraryInner /></Suspense>;
}
