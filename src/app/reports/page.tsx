'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';

interface Report { id: string; title: string; shareSlug: string | null }
interface Dash { id: string; name: string }
interface Widget { id: string; title: string }

export default function ReportsPage() {
  const [list, setList] = useState<Report[]>([]);
  const [dashboards, setDashboards] = useState<Dash[]>([]);
  const [widgetsByDash, setWidgetsByDash] = useState<Record<string, Widget[]>>({});
  const [title, setTitle] = useState('');
  const [instruction, setInstruction] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());

  async function load() {
    setList(await (await fetch('/api/reports')).json());
    const ds: Dash[] = await (await fetch('/api/dashboards')).json();
    setDashboards(ds);
    const map: Record<string, Widget[]> = {};
    for (const d of ds) {
      const detail = await (await fetch(`/api/dashboards/${d.id}`)).json();
      map[d.id] = detail.widgets ?? [];
    }
    setWidgetsByDash(map);
  }
  useEffect(() => { load(); }, []);

  function toggle(id: string) {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id); else next.add(id);
    setSelected(next);
  }

  async function create(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim() || selected.size === 0) return;
    const sources = [...selected].map((widgetId) => ({ widgetId }));
    await fetch('/api/reports', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title, instruction, sources }) });
    setTitle(''); setInstruction(''); setSelected(new Set());
    load();
  }

  return (
    <main className="mx-auto max-w-3xl p-6">
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-lg font-semibold">Reports</h1>
        <Link href="/dashboards" className="text-sm text-blue-600">Dashboards →</Link>
      </div>

      <form onSubmit={create} className="mb-6 space-y-2 rounded border border-neutral-200 p-4 dark:border-neutral-800">
        <input className="w-full rounded border p-2 dark:bg-neutral-900" placeholder="Report title" value={title} onChange={(e) => setTitle(e.target.value)} />
        <input className="w-full rounded border p-2 dark:bg-neutral-900" placeholder="Optional instruction (e.g. focus on Q2 growth)" value={instruction} onChange={(e) => setInstruction(e.target.value)} />
        <div className="text-xs text-neutral-500">Pick source widgets:</div>
        {dashboards.length === 0 && <p className="text-xs text-neutral-500">No widgets yet — pin some chat results first.</p>}
        {dashboards.map((d) => (
          <div key={d.id}>
            <div className="text-xs font-medium">{d.name}</div>
            {(widgetsByDash[d.id] ?? []).map((w) => (
              <label key={w.id} className="ml-2 flex items-center gap-1 text-sm">
                <input type="checkbox" checked={selected.has(w.id)} onChange={() => toggle(w.id)} /> {w.title}
              </label>
            ))}
          </div>
        ))}
        <button className="rounded bg-blue-600 px-4 py-2 text-white disabled:opacity-50" disabled={!title.trim() || selected.size === 0}>Create report</button>
      </form>

      <ul className="space-y-2">
        {list.map((r) => (
          <li key={r.id} className="flex items-center justify-between rounded border border-neutral-200 p-3 dark:border-neutral-800">
            <Link href={`/reports/${r.id}`} className="font-medium text-blue-600">{r.title}</Link>
            {r.shareSlug && <span className="text-xs text-green-600">shared</span>}
          </li>
        ))}
      </ul>
    </main>
  );
}
