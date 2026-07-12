'use client';

import { use, useCallback, useEffect, useState } from 'react';
import Link from 'next/link';

interface Schedule {
  id: string; name: string; mode: string; sql: string | null; question: string | null;
  cron: string; webhookUrl: string | null; isEnabled: boolean; lastRunAt: string | null;
  targetId?: string | null; targetName?: string | null;
}

const CRON_PRESETS = [
  { label: 'Hourly', value: '0 * * * *' },
  { label: 'Daily 07:00', value: '0 7 * * *' },
  { label: 'Weekly Mon 07:00', value: '0 7 * * 1' },
];

/** Automations: scheduled queries for this connection (cron + optional webhook).
 *  API keys / MCP setup are global — they live in Settings. */
export default function AutomationsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [list, setList] = useState<Schedule[]>([]);
  const [msg, setMsg] = useState('');
  const [f, setF] = useState({ name: '', cron: '0 7 * * *', sql: '', webhookUrl: '' });
  // Monitor mode: watch tables for data drift (snapshot-diff, no LLM).
  const [formMode, setFormMode] = useState<'sql' | 'monitor'>('sql');
  const [tables, setTables] = useState<string[]>([]);
  const [pickedTables, setPickedTables] = useState<Set<string>>(new Set());
  const [thresholds, setThresholds] = useState({ rowCountPct: '30', nullRatePoints: '10', avgPct: '50' });
  useEffect(() => {
    fetch(`/api/connections/${id}/schema`).then((r) => r.json())
      .then((d) => setTables((d.tables ?? []).map((t: { tableName: string }) => t.tableName)))
      .catch(() => {});
  }, [id]);

  const load = useCallback(async () => {
    setList(await (await fetch(`/api/connections/${id}/schedules`)).json());
  }, [id]);
  useEffect(() => { load(); }, [load]);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setMsg('');
    const body = formMode === 'monitor'
      ? { action: 'create', name: f.name, mode: 'monitor', cron: f.cron, webhookUrl: f.webhookUrl || undefined,
          config: { tables: [...pickedTables], thresholds: { rowCountPct: Number(thresholds.rowCountPct), nullRatePoints: Number(thresholds.nullRatePoints) / 100, avgPct: Number(thresholds.avgPct) } } }
      : { action: 'create', name: f.name, mode: 'sql', sql: f.sql, cron: f.cron, webhookUrl: f.webhookUrl || undefined };
    const r = await fetch(`/api/connections/${id}/schedules`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const d = await r.json();
    if (!r.ok) { setMsg(d.error ?? 'create failed'); return; }
    setF({ name: '', cron: '0 7 * * *', sql: '', webhookUrl: '' });
    setMsg('Schedule created ✓');
    load();
  }

  async function toggle(s: Schedule) {
    await fetch(`/api/connections/${id}/schedules`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ scheduleId: s.id, isEnabled: !s.isEnabled }),
    });
    load();
  }

  async function remove(s: Schedule) {
    if (!confirm(`Delete schedule "${s.name}"?`)) return;
    await fetch(`/api/connections/${id}/schedules`, {
      method: 'DELETE', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ scheduleId: s.id }),
    });
    load();
  }

  async function runNow(s: Schedule) {
    setMsg(`Running "${s.name}"…`);
    const r = await fetch(`/api/connections/${id}/schedules`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'run', scheduleId: s.id }),
    });
    setMsg(r.ok ? `Ran "${s.name}" ✓` : 'run failed');
    load();
  }

  return (
    <main className="mx-auto max-w-3xl p-6">
      <div className="mb-1 flex items-center justify-between">
        <h1 className="text-lg font-semibold">Automations</h1>
        <Link href="/settings" className="text-sm text-blue-600">API keys & MCP → Settings</Link>
      </div>
      <p className="mb-4 text-xs text-neutral-500">Run a saved SQL on a cron schedule; optionally POST the result to a webhook. Tip: on any chat result, click ⏰ Schedule.</p>

      <form onSubmit={create} className="mb-6 space-y-2 rounded border border-neutral-200 p-4 text-sm dark:border-neutral-800">
        <input className="w-full rounded border p-2 dark:bg-neutral-900" placeholder="Name (e.g. Daily revenue)" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
        <div className="flex flex-wrap items-center gap-2">
          {CRON_PRESETS.map((p) => (
            <button key={p.value} type="button" onClick={() => setF({ ...f, cron: p.value })}
              className={`rounded px-2 py-1 text-xs ${f.cron === p.value ? 'bg-blue-600 text-white' : 'border text-neutral-600 dark:text-neutral-300'}`}>{p.label}</button>
          ))}
          <input className="w-36 rounded border p-1 font-mono text-xs dark:bg-neutral-900" value={f.cron} onChange={(e) => setF({ ...f, cron: e.target.value })} title="cron expression (5 fields)" />
        </div>
        <div className="flex gap-1 text-xs">
          {(['sql', 'monitor'] as const).map((m) => (
            <button key={m} type="button" onClick={() => setFormMode(m)}
              className={`rounded px-2 py-1 ${formMode === m ? 'bg-blue-600 text-white' : 'border text-neutral-600 dark:text-neutral-300'}`}>
              {m === 'sql' ? 'Scheduled SQL' : '🔎 Data monitor'}
            </button>
          ))}
        </div>
        {formMode === 'sql' && (
          <textarea className="w-full rounded border p-2 font-mono text-xs dark:bg-neutral-900" rows={3} placeholder="SELECT …" value={f.sql} onChange={(e) => setF({ ...f, sql: e.target.value })} />
        )}
        {formMode === 'monitor' && (
          <div className="space-y-2 rounded border border-neutral-200 p-2 text-xs dark:border-neutral-800" data-testid="monitor-config">
            <div className="font-medium">Watch tables (snapshot-diff mỗi lần chạy, alert khi lệch ngưỡng):</div>
            <div className="flex max-h-32 flex-wrap gap-2 overflow-y-auto">
              {tables.map((t) => (
                <label key={t} className="flex items-center gap-1">
                  <input type="checkbox" checked={pickedTables.has(t)} onChange={() => {
                    const next = new Set(pickedTables);
                    if (next.has(t)) next.delete(t); else next.add(t);
                    setPickedTables(next);
                  }} /> <span className="font-mono">{t}</span>
                </label>
              ))}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <label>rows ±<input className="w-14 rounded border p-1 dark:bg-neutral-900" value={thresholds.rowCountPct} onChange={(e) => setThresholds({ ...thresholds, rowCountPct: e.target.value })} />%</label>
              <label>null +<input className="w-14 rounded border p-1 dark:bg-neutral-900" value={thresholds.nullRatePoints} onChange={(e) => setThresholds({ ...thresholds, nullRatePoints: e.target.value })} />đ%</label>
              <label>avg ±<input className="w-14 rounded border p-1 dark:bg-neutral-900" value={thresholds.avgPct} onChange={(e) => setThresholds({ ...thresholds, avgPct: e.target.value })} />%</label>
            </div>
            <p className="text-neutral-400">Lần chạy đầu chỉ ghi baseline. Diff nhỏ hơn 20 rows tuyệt đối sẽ bỏ qua (chống false-alarm bảng nhỏ).</p>
          </div>
        )}
        <input className="w-full rounded border p-2 dark:bg-neutral-900" placeholder="Webhook URL (optional — result/alert is POSTed as JSON)" value={f.webhookUrl} onChange={(e) => setF({ ...f, webhookUrl: e.target.value })} />
        <button className="rounded bg-blue-600 px-4 py-2 text-white disabled:opacity-50" disabled={!f.name.trim() || !f.cron.trim() || (formMode === 'sql' ? !f.sql.trim() : pickedTables.size === 0)}>Create schedule</button>
      </form>

      {msg && <p className="mb-2 text-sm text-amber-600">{msg}</p>}
      {list.length === 0 && <p className="text-sm text-neutral-500">No schedules yet.</p>}
      <ul className="space-y-2">
        {list.map((s) => (
          <li key={s.id} className="rounded border border-neutral-200 p-2 text-sm dark:border-neutral-800">
            <div className="flex items-center justify-between gap-2">
              <span className="font-medium">{s.name} {!s.isEnabled && <span className="text-xs text-neutral-400">(disabled)</span>}</span>
              <div className="flex gap-2 text-xs">
                <button onClick={() => runNow(s)} className="text-blue-600">Run now</button>
                <button onClick={() => toggle(s)} className="text-amber-600">{s.isEnabled ? 'Disable' : 'Enable'}</button>
                <button onClick={() => remove(s)} className="text-red-600">Delete</button>
              </div>
            </div>
            <div className="mt-0.5 text-xs text-neutral-500">
              <span className="font-mono">{s.cron}</span>
              {s.webhookUrl && <span> · → {s.webhookUrl}</span>}
              {s.lastRunAt && <span> · last run {new Date(s.lastRunAt).toLocaleString()}</span>}
            </div>
            {(s.sql || s.question) && <pre className="mt-1 overflow-x-auto text-xs text-neutral-500">{s.sql ?? s.question}</pre>}
            {s.targetName && <p className="mt-1 text-xs text-neutral-500">{s.mode === 'dashboard_refresh' ? '📊 refresh dashboard' : s.mode === 'report_regenerate' ? '📝 regenerate report' : s.mode} · <b>{s.targetName}</b></p>}
            {s.mode === 'metrics_digest' && <p className="mt-1 text-xs text-neutral-500">📈 metrics digest — all metrics of this connection, 1 LLM call/run</p>}
            {s.mode === 'monitor' && <p className="mt-1 text-xs text-neutral-500">🔎 data monitor</p>}
            <RunHistory connectionId={id} scheduleId={s.id} />
          </li>
        ))}
      </ul>
    </main>
  );
}

interface RunRow { id: string; status: string; detail: string | null; ranAt: string; rowCount: number | null }

/** Collapsible last-runs list per schedule. Digest runs keep their (capped)
 *  markdown in `detail`, so a webhook-less digest is still readable here. */
function RunHistory({ connectionId, scheduleId }: { connectionId: string; scheduleId: string }) {
  const [open, setOpen] = useState(false);
  const [runs, setRuns] = useState<RunRow[] | null>(null);
  async function toggleOpen() {
    const next = !open;
    setOpen(next);
    if (next && runs === null) {
      const r = await fetch(`/api/connections/${connectionId}/schedules/runs?scheduleId=${scheduleId}`);
      setRuns(await r.json().catch(() => []));
    }
  }
  return (
    <div className="mt-1">
      <button onClick={toggleOpen} className="text-xs text-blue-600" data-testid="run-history-toggle">
        {open ? 'Hide runs' : 'Show runs'}
      </button>
      {open && runs && (
        <ul className="mt-1 space-y-1 text-xs" data-testid="run-history">
          {runs.map((r) => (
            <li key={r.id} className="rounded border border-neutral-200 p-1.5 dark:border-neutral-800">
              <span className={r.status === 'ok' ? 'text-green-600' : r.status === 'skipped' ? 'text-neutral-400' : 'text-amber-600'}>{r.status}</span>
              <span className="text-neutral-400"> · {new Date(r.ranAt).toLocaleString()}{r.rowCount != null ? ` · ${r.rowCount} rows` : ''}</span>
              {r.detail && <pre className="mt-0.5 whitespace-pre-wrap text-neutral-500">{r.detail}</pre>}
            </li>
          ))}
          {runs.length === 0 && <li className="text-neutral-400">No runs yet.</li>}
        </ul>
      )}
    </div>
  );
}
