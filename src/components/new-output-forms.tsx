'use client';

import { useEffect, useState } from 'react';

/** Create-dashboard / create-report forms for the Library page — ported from the
 *  old /dashboards and /reports list pages so merging the lists loses no feature. */

export function NewDashboardForm({ onCreated }: { onCreated: () => void }) {
  const [name, setName] = useState('');
  async function create(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    await fetch('/api/dashboards', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name }) });
    setName('');
    onCreated();
  }
  return (
    <form onSubmit={create} className="mb-4 flex gap-2">
      <input className="flex-1 rounded border p-2 text-sm dark:bg-neutral-900" placeholder="New dashboard name" value={name} onChange={(e) => setName(e.target.value)} />
      <button className="rounded bg-blue-600 px-4 py-2 text-sm text-white disabled:opacity-50" disabled={!name.trim()}>Create</button>
    </form>
  );
}

interface Dash { id: string; name: string }
interface Widget { id: string; title: string }
interface Nb { id: string; title: string }

export function NewReportForm({ onCreated }: { onCreated: () => void }) {
  const [dashboards, setDashboards] = useState<Dash[]>([]);
  const [widgetsByDash, setWidgetsByDash] = useState<Record<string, Widget[]>>({});
  const [notebooks, setNotebooks] = useState<Nb[]>([]);
  const [pickedNbs, setPickedNbs] = useState<Set<string>>(new Set());
  const [title, setTitle] = useState('');
  const [instruction, setInstruction] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());

  useEffect(() => {
    (async () => {
      const ds: Dash[] = await (await fetch('/api/dashboards')).json();
      setDashboards(ds);
      const map: Record<string, Widget[]> = {};
      for (const d of ds) {
        const detail = await (await fetch(`/api/dashboards/${d.id}`)).json();
        map[d.id] = detail.widgets ?? [];
      }
      setWidgetsByDash(map);
      setNotebooks(await (await fetch('/api/notebooks')).json());
    })();
  }, []);

  function toggle(id: string) {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id); else next.add(id);
    setSelected(next);
  }

  async function create(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim() || (selected.size === 0 && pickedNbs.size === 0)) return;
    const sources = [...[...selected].map((widgetId) => ({ widgetId })), ...[...pickedNbs].map((notebookId) => ({ notebookId }))];
    await fetch('/api/reports', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title, instruction, sources }) });
    setTitle(''); setInstruction(''); setSelected(new Set());
    onCreated();
  }

  return (
    <form onSubmit={create} className="mb-4 space-y-2 rounded border border-neutral-200 p-4 text-sm dark:border-neutral-800">
      <input className="w-full rounded border p-2 dark:bg-neutral-900" placeholder="Report title" value={title} onChange={(e) => setTitle(e.target.value)} />
      <input className="w-full rounded border p-2 dark:bg-neutral-900" placeholder="Optional instruction (e.g. focus on Q2 growth)" value={instruction} onChange={(e) => setInstruction(e.target.value)} />
      <div className="text-xs text-neutral-500">Pick source widgets:</div>
      {dashboards.length === 0 && <p className="text-xs text-neutral-500">No widgets yet — pin some chat results first.</p>}
      {dashboards.map((d) => (
        <div key={d.id}>
          <div className="text-xs font-medium">{d.name}</div>
          {(widgetsByDash[d.id] ?? []).map((w) => (
            <label key={w.id} className="ml-2 flex items-center gap-1">
              <input type="checkbox" checked={selected.has(w.id)} onChange={() => toggle(w.id)} /> {w.title}
            </label>
          ))}
        </div>
      ))}
      {notebooks.length > 0 && (
        <>
          <div className="text-xs text-neutral-500">…hoặc/và chọn notebook làm nguồn:</div>
          {notebooks.map((n) => (
            <label key={n.id} className="ml-2 flex items-center gap-1">
              <input type="checkbox" checked={pickedNbs.has(n.id)} onChange={() => {
                const next = new Set(pickedNbs);
                if (next.has(n.id)) next.delete(n.id); else next.add(n.id);
                setPickedNbs(next);
              }} /> 📓 {n.title}
            </label>
          ))}
        </>
      )}
      <button className="rounded bg-blue-600 px-4 py-2 text-white disabled:opacity-50" disabled={!title.trim() || (selected.size === 0 && pickedNbs.size === 0)}>Create report</button>
    </form>
  );
}
