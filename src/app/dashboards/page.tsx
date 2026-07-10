'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';

interface Dash { id: string; name: string; shareSlug: string | null }

export default function DashboardsPage() {
  const [list, setList] = useState<Dash[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [name, setName] = useState('');

  async function load() {
    setList(await (await fetch('/api/dashboards')).json());
    setLoaded(true);
  }
  useEffect(() => { load(); }, []);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    await fetch('/api/dashboards', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name }) });
    setName('');
    load();
  }

  return (
    <main className="mx-auto max-w-3xl p-6">
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-lg font-semibold">Dashboards</h1>
      </div>
      <form onSubmit={create} className="mb-4 flex gap-2">
        <input className="flex-1 rounded border p-2 dark:bg-neutral-900" placeholder="New dashboard name" value={name} onChange={(e) => setName(e.target.value)} />
        <button className="rounded bg-blue-600 px-4 py-2 text-white">Create</button>
      </form>
      <ul className="space-y-2">
        {!loaded && <p className="text-sm text-neutral-400">Loading…</p>}
        {loaded && list.length === 0 && <p className="text-sm text-neutral-500">No dashboards yet. In a chat, click “Pin to dashboard” on any result — or create one above.</p>}
        {list.map((d) => (
          <li key={d.id} className="flex items-center justify-between rounded border border-neutral-200 p-3 dark:border-neutral-800">
            <Link href={`/dashboards/${d.id}`} className="font-medium text-blue-600">{d.name}</Link>
            {d.shareSlug && <span className="text-xs text-green-600">shared</span>}
          </li>
        ))}
      </ul>
    </main>
  );
}
