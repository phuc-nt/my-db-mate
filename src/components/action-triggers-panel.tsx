'use client';

import { useCallback, useEffect, useState } from 'react';

interface TriggerCondition { surface: 'monitor' | 'digest'; tableOrMetric?: string; kind: 'any' | 'name-match' | 'delta-threshold'; threshold?: number }
interface Trigger { id: string; name: string; isEnabled: boolean; condition: TriggerCondition; webhookUrl: string; rateLimitPerHour: number }
interface Fire { id: string; status: string; httpStatus: number | null; error: string | null; firedAt: string }

/** Action triggers: "when a monitor/digest finding matches CONDITION, POST to a
 *  webhook". Webhook-out only — the app never writes to your source database. */
export function ActionTriggersPanel({ connectionId }: { connectionId: string }) {
  const [list, setList] = useState<Trigger[]>([]);
  const [msg, setMsg] = useState('');
  const [f, setF] = useState({ name: '', surface: 'monitor' as 'monitor' | 'digest', kind: 'any' as TriggerCondition['kind'], tableOrMetric: '', threshold: '20', webhookUrl: '', rateLimitPerHour: '10' });

  const load = useCallback(async () => {
    setList(await (await fetch(`/api/connections/${connectionId}/action-triggers`)).json());
  }, [connectionId]);
  useEffect(() => { load(); }, [load]);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setMsg('');
    const condition: TriggerCondition = {
      surface: f.surface, kind: f.kind,
      ...(f.kind === 'name-match' && f.tableOrMetric.trim() ? { tableOrMetric: f.tableOrMetric.trim() } : {}),
      ...(f.kind === 'delta-threshold' ? { threshold: Number(f.threshold) } : {}),
    };
    const r = await fetch(`/api/connections/${connectionId}/action-triggers`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: f.name, condition, webhookUrl: f.webhookUrl, rateLimitPerHour: Number(f.rateLimitPerHour) }),
    });
    const d = await r.json();
    if (!r.ok) { setMsg(d.error ?? 'create failed'); return; }
    setF({ ...f, name: '', tableOrMetric: '', webhookUrl: '' });
    setMsg('Trigger created ✓');
    load();
  }

  async function toggle(t: Trigger) {
    await fetch(`/api/connections/${connectionId}/action-triggers`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ triggerId: t.id, isEnabled: !t.isEnabled }) });
    load();
  }
  async function remove(t: Trigger) {
    if (!confirm(`Delete trigger "${t.name}"?`)) return;
    await fetch(`/api/connections/${connectionId}/action-triggers`, { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ triggerId: t.id }) });
    load();
  }
  async function test(t: Trigger) {
    setMsg(`Testing "${t.name}"…`);
    const r = await (await fetch(`/api/connections/${connectionId}/action-triggers`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'test', triggerId: t.id }) })).json();
    setMsg(`${t.name}: ${r.detail ?? (r.ok ? 'delivered' : 'failed')}`);
    load();
  }

  return (
    <section className="mt-6" data-testid="action-triggers">
      <h2 className="mb-1 text-sm font-semibold">⚡ Action triggers</h2>
      <p className="mb-3 text-xs text-neutral-500">
        When a monitor or digest finding matches a condition, POST a JSON payload to a webhook (n8n / Zapier / a Slack bridge).
        Webhook-out only — this never writes to your source database.
      </p>

      <form onSubmit={create} className="mb-4 space-y-2 rounded border border-neutral-200 p-3 text-sm dark:border-neutral-800">
        <input className="w-full rounded border p-2 dark:bg-neutral-900" placeholder="Name (e.g. Alert on row-count collapse)" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <select className="rounded border p-1 dark:bg-neutral-900" value={f.surface} onChange={(e) => setF({ ...f, surface: e.target.value as 'monitor' | 'digest' })}>
            <option value="monitor">monitor finding</option>
            <option value="digest">digest change</option>
          </select>
          <select className="rounded border p-1 dark:bg-neutral-900" value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value as TriggerCondition['kind'] })}>
            <option value="any">any finding</option>
            <option value="name-match">name matches…</option>
            <option value="delta-threshold">|Δ%| ≥…</option>
          </select>
          {f.kind === 'name-match' && <input className="w-40 rounded border p-1 dark:bg-neutral-900" placeholder={f.surface === 'monitor' ? 'table name' : 'metric name'} value={f.tableOrMetric} onChange={(e) => setF({ ...f, tableOrMetric: e.target.value })} />}
          {f.kind === 'delta-threshold' && <input className="w-16 rounded border p-1 dark:bg-neutral-900" value={f.threshold} onChange={(e) => setF({ ...f, threshold: e.target.value })} />}
          <label className="flex items-center gap-1">rate <input className="w-14 rounded border p-1 dark:bg-neutral-900" value={f.rateLimitPerHour} onChange={(e) => setF({ ...f, rateLimitPerHour: e.target.value })} />/h</label>
        </div>
        <input className="w-full rounded border p-2 dark:bg-neutral-900" placeholder="Webhook URL (POST target)" value={f.webhookUrl} onChange={(e) => setF({ ...f, webhookUrl: e.target.value })} />
        <button className="rounded bg-blue-600 px-3 py-1.5 text-white disabled:opacity-50" disabled={!f.name.trim() || !f.webhookUrl.trim()}>Create trigger</button>
      </form>

      {msg && <p className="mb-2 text-xs text-amber-600">{msg}</p>}
      <ul className="space-y-2">
        {list.map((t) => (
          <li key={t.id} className="rounded border border-neutral-200 p-2 text-sm dark:border-neutral-800" data-testid="trigger-row">
            <div className="flex items-center justify-between gap-2">
              <span className="font-medium">{t.name} {!t.isEnabled && <span className="text-xs text-neutral-400">(disabled)</span>}</span>
              <div className="flex gap-2 text-xs">
                <button onClick={() => test(t)} className="text-blue-600">Test fire</button>
                <button onClick={() => toggle(t)} className="text-amber-600">{t.isEnabled ? 'Disable' : 'Enable'}</button>
                <button onClick={() => remove(t)} className="text-red-600">Delete</button>
              </div>
            </div>
            <p className="mt-0.5 text-xs text-neutral-500">
              {t.condition.surface} · {t.condition.kind === 'any' ? 'any finding' : t.condition.kind === 'name-match' ? `name = ${t.condition.tableOrMetric}` : `|Δ%| ≥ ${t.condition.threshold}`} · ≤{t.rateLimitPerHour}/h → {t.webhookUrl}
            </p>
            <FireHistory connectionId={connectionId} triggerId={t.id} />
          </li>
        ))}
        {list.length === 0 && <li className="text-xs text-neutral-500">No triggers yet.</li>}
      </ul>
    </section>
  );
}

function FireHistory({ connectionId, triggerId }: { connectionId: string; triggerId: string }) {
  const [open, setOpen] = useState(false);
  const [fires, setFires] = useState<Fire[] | null>(null);
  async function toggle() {
    const next = !open;
    setOpen(next);
    if (next) setFires(await (await fetch(`/api/connections/${connectionId}/action-triggers?fires=${triggerId}`)).json());
  }
  return (
    <div className="mt-1">
      <button onClick={toggle} className="text-xs text-blue-600">{open ? 'Hide fires' : 'Show fires'}</button>
      {open && fires && (
        <ul className="mt-1 space-y-0.5 text-xs" data-testid="fire-history">
          {fires.map((fr) => (
            <li key={fr.id}>
              <span className={fr.status === 'delivered' ? 'text-green-600' : fr.status === 'suppressed' ? 'text-neutral-400' : 'text-amber-600'}>{fr.status}</span>
              <span className="text-neutral-400"> · {new Date(fr.firedAt).toLocaleString()}{fr.httpStatus ? ` · HTTP ${fr.httpStatus}` : ''}{fr.error ? ` · ${fr.error}` : ''}</span>
            </li>
          ))}
          {fires.length === 0 && <li className="text-neutral-400">No fires yet.</li>}
        </ul>
      )}
    </div>
  );
}
