'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { DEFAULT_PORT, kindForEngine, parseConnectionString, type Engine, type SslMode } from '../../lib/connection-config';
import { PROVIDER_PRESETS, getPreset } from '../../lib/provider-presets';

interface Conn { id: string; name: string; kind: string; dialect: string; isReadOnlyVerified: boolean; config: Record<string, unknown>; bigqueryMaxBytesPerQuery?: number; bigqueryDailyBytesBudget?: number; bigqueryOfflineMode?: boolean }

const BQ_DEFAULT_MAX_BYTES = 1_073_741_824; // 1 GiB ≈ $0.006/query at $6.25/TiB on-demand pricing.
const BQ_DEFAULT_DAILY_BUDGET = 10_737_418_240; // 10 GiB/day ≈ $0.06/day — daily cap for background analytics.

const BLANK = {
  name: '', engine: 'postgres' as Engine, path: '', host: 'localhost', port: '5432', database: '', user: '', secret: '',
  ssl: 'disable' as SslMode, sslCa: '', options: '',
  // SSH tunnel (optional). authMethod 'key' → sshSecret is a PEM private key; 'password' → a password.
  sshOn: false, sshHost: '', sshPort: '22', sshUser: '', sshAuthMethod: 'key' as 'key' | 'password', sshSecret: '',
  // BigQuery (write-only service-account JSON, same "blank keeps current" pattern as password/SSH key).
  bqProjectId: '', bqServiceAccountJson: '', bqMaxBytesPerQuery: String(BQ_DEFAULT_MAX_BYTES),
  bqDailyBytesBudget: String(BQ_DEFAULT_DAILY_BUDGET), bqOfflineMode: false,
};

export default function ConnectionsPage() {
  const [conns, setConns] = useState<Conn[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [form, setForm] = useState({ ...BLANK });
  const [editingId, setEditingId] = useState<string | null>(null);
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const [presetNote, setPresetNote] = useState('');

  const load = () => fetch('/api/connections').then((r) => r.json()).then(setConns).then(() => setLoaded(true));
  useEffect(() => { load(); }, []);

  /** Switching engine sets the conventional default port (like DBeaver). */
  function setEngine(engine: Engine) {
    setForm((f) => ({ ...f, engine, port: engine === 'sqlite' || engine === 'bigquery' ? '' : String(DEFAULT_PORT[engine]) }));
  }

  /** Picking a provider preset pre-fills engine/port/SSL and shows its note.
   *  Pure convenience — every field stays editable, config stored is unchanged. */
  function applyPreset(id: string) {
    const p = getPreset(id);
    if (!p || id === 'generic') { setPresetNote(''); return; }
    setForm((f) => ({ ...f, engine: p.engine, port: String(p.port), ssl: p.ssl }));
    setPresetNote(p.note ?? '');
  }

  /** Paste a connection URL → fill the fields (postgres://… / mysql://…). */
  function pasteUrl(raw: string) {
    if (!raw.trim()) return;
    try {
      const p = parseConnectionString(raw);
      setForm((f) => ({ ...f, engine: p.engine, host: p.host, port: String(p.port), database: p.database, user: p.user, secret: p.password, ssl: p.ssl, options: p.options ?? '' }));
      setMsg('Filled from connection string.');
    } catch (e) {
      setMsg(`Could not parse URL: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  function buildBody() {
    const kind = kindForEngine(form.engine);
    if (form.engine === 'bigquery') {
      return {
        name: form.name, kind, dialect: form.engine, config: { projectId: form.bqProjectId.trim() },
        ...(form.bqServiceAccountJson.trim() ? { bigqueryServiceAccountJson: form.bqServiceAccountJson.trim() } : {}),
        bigqueryMaxBytesPerQuery: Number(form.bqMaxBytesPerQuery) || BQ_DEFAULT_MAX_BYTES,
        bigqueryDailyBytesBudget: Number(form.bqDailyBytesBudget) || BQ_DEFAULT_DAILY_BUDGET,
        bigqueryOfflineMode: form.bqOfflineMode,
      };
    }
    const ssh = form.sshOn && form.sshHost.trim()
      ? { sshHost: form.sshHost.trim(), sshPort: Number(form.sshPort) || 22, sshUser: form.sshUser.trim(), sshAuthMethod: form.sshAuthMethod }
      : {};
    const config = form.engine === 'sqlite'
      ? { path: form.path }
      : {
          host: form.host, port: Number(form.port), database: form.database, user: form.user,
          ssl: form.ssl,
          ...(form.ssl === 'verify-full' && form.sslCa.trim() ? { sslCa: form.sslCa } : {}),
          ...(form.engine === 'postgres' && form.options.trim() ? { options: form.options.trim() } : {}),
          ...ssh,
        };
    return {
      name: form.name, kind, dialect: form.engine, config,
      secret: form.engine === 'sqlite' ? undefined : form.secret,
      ...(form.sshOn && form.sshSecret ? { sshSecret: form.sshSecret } : {}),
    };
  }

  async function test() {
    setBusy(true); setMsg('Testing…');
    const body = buildBody();
    const res = await fetch('/api/connections/test', { method: 'POST', body: JSON.stringify(body) });
    const d = await res.json();
    setMsg(d.ok ? (d.isReadOnly ? 'Connected — read-only ✓' : `⚠ Connected but the DB user can WRITE. ${d.detail}`) : `Failed: ${d.detail}`);
    setBusy(false);
  }

  async function save() {
    setBusy(true); setMsg('');
    const body = buildBody();
    if (editingId) {
      const res = await fetch(`/api/connections/${editingId}`, { method: 'PATCH', body: JSON.stringify(body) });
      const d = await res.json();
      if (!res.ok) setMsg(`Error: ${d.error}`);
      else { setMsg('Saved ✓'); await fetch(`/api/connections/${editingId}/sync`, { method: 'POST' }); resetForm(); load(); }
    } else {
      const res = await fetch('/api/connections', { method: 'POST', body: JSON.stringify(body) });
      const d = await res.json();
      if (!res.ok) setMsg(`Error: ${d.error}`);
      else { setMsg(d.isReadOnlyVerified ? 'Connected — read-only verified ✓' : '⚠ Connected but the DB user can WRITE. Use a SELECT-only user for production.'); await fetch(`/api/connections/${d.id}/sync`, { method: 'POST' }); resetForm(); load(); }
    }
    setBusy(false);
  }

  function editConn(c: Conn) {
    const cfg = c.config ?? {};
    setEditingId(c.id);
    setForm({
      name: c.name,
      engine: c.dialect as Engine,
      path: String(cfg.path ?? ''),
      host: String(cfg.host ?? 'localhost'),
      port: String(cfg.port ?? (c.dialect === 'mysql' ? 3306 : 5432)),
      database: String(cfg.database ?? ''),
      user: String(cfg.user ?? ''),
      secret: '', // never pre-filled; blank keeps the existing password
      ssl: (cfg.ssl === 'require' || cfg.ssl === 'verify-full' ? cfg.ssl : 'disable') as SslMode,
      sslCa: String(cfg.sslCa ?? ''),
      options: String(cfg.options ?? ''),
      sshOn: Boolean(cfg.sshHost),
      sshHost: String(cfg.sshHost ?? ''),
      sshPort: String(cfg.sshPort ?? '22'),
      sshUser: String(cfg.sshUser ?? ''),
      sshAuthMethod: (cfg.sshAuthMethod === 'password' ? 'password' : 'key') as 'key' | 'password',
      sshSecret: '', // never pre-filled; blank keeps the existing key
      bqProjectId: String(cfg.projectId ?? ''),
      bqServiceAccountJson: '', // never pre-filled; blank keeps the existing service-account JSON
      bqMaxBytesPerQuery: String(c.bigqueryMaxBytesPerQuery ?? BQ_DEFAULT_MAX_BYTES),
      bqDailyBytesBudget: String(c.bigqueryDailyBytesBudget ?? BQ_DEFAULT_DAILY_BUDGET),
      bqOfflineMode: c.bigqueryOfflineMode ?? false,
    });
    setPresetNote('');
    setMsg('Editing — leave password blank to keep the current one.');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function resetForm() { setEditingId(null); setForm({ ...BLANK }); setPresetNote(''); }

  /** One-click demo: sample shop DB + seeded context, then straight into chat. */
  async function tryDemo() {
    setBusy(true); setMsg('Setting up the demo database…');
    const res = await fetch('/api/demo', { method: 'POST' });
    const d = await res.json();
    if (!res.ok) { setMsg(`Error: ${d.error}`); setBusy(false); return; }
    window.location.href = `/db/${d.id}/chat`;
  }

  async function remove(id: string) {
    await fetch(`/api/connections/${id}`, { method: 'DELETE' });
    if (editingId === id) resetForm();
    load();
  }

  const isSqlite = form.engine === 'sqlite';
  const isBigQuery = form.engine === 'bigquery';

  return (
    <main className="mx-auto max-w-3xl p-6">
      <h1 className="mb-4 text-2xl font-semibold">Connections</h1>

      <div className="mb-6 rounded-lg border border-neutral-300 p-4 dark:border-neutral-700">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="font-medium">{editingId ? 'Edit connection' : 'Add connection'}</h2>
          {editingId && <button onClick={resetForm} className="text-xs text-blue-600">+ New instead</button>}
        </div>

        {/* Engine picker */}
        <div className="mb-3 flex gap-2">
          {(['postgres', 'mysql', 'sqlite', 'mssql', 'bigquery'] as Engine[]).map((e) => (
            <button key={e} onClick={() => setEngine(e)} disabled={!!editingId}
              className={`rounded border px-3 py-1.5 text-sm capitalize disabled:opacity-50 ${form.engine === e ? 'border-blue-600 bg-blue-50 font-medium text-blue-700 dark:bg-blue-950 dark:text-blue-300' : ''}`}>
              {e === 'postgres' ? '🐘 PostgreSQL' : e === 'mysql' ? '🐬 MySQL' : e === 'sqlite' ? '📄 SQLite' : e === 'mssql' ? '🟦 SQL Server' : '🔷 BigQuery'}
            </button>
          ))}
        </div>

        {/* Provider preset (TCP only) — fills engine/port/SSL, then everything stays editable. */}
        {!isSqlite && !isBigQuery && !editingId && (
          <select defaultValue="generic" onChange={(e) => applyPreset(e.target.value)}
            className="mb-2 w-full rounded border p-2 text-sm dark:bg-neutral-900">
            <option value="generic">Provider preset (optional)…</option>
            {PROVIDER_PRESETS.filter((p) => p.id !== 'generic').map((p) => (
              <option key={p.id} value={p.id}>{p.label}</option>
            ))}
          </select>
        )}
        {presetNote && <p className="mb-2 text-xs text-neutral-500">{presetNote}</p>}

        {/* Connection-string paste (TCP only) */}
        {!isSqlite && !isBigQuery && !editingId && (
          <input className="mb-2 w-full rounded border p-2 text-sm dark:bg-neutral-900"
            placeholder="Paste connection string (postgres://user:pass@host:5432/db?sslmode=require) — optional"
            onChange={(e) => pasteUrl(e.target.value)} />
        )}

        <div className="grid grid-cols-2 gap-2">
          <input className="col-span-2 rounded border p-2 dark:bg-neutral-900" placeholder="Name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          {isSqlite ? (
            <input className="col-span-2 rounded border p-2 dark:bg-neutral-900" placeholder="Absolute path to .db" value={form.path} onChange={(e) => setForm({ ...form, path: e.target.value })} />
          ) : isBigQuery ? (
            <>
              <input className="col-span-2 rounded border p-2 dark:bg-neutral-900" placeholder="GCP project ID" value={form.bqProjectId} onChange={(e) => setForm({ ...form, bqProjectId: e.target.value })} />
              <textarea className="col-span-2 rounded border p-2 font-mono text-xs dark:bg-neutral-900" rows={6}
                placeholder={editingId ? 'Service-account JSON key — blank keeps the current one' : 'Service-account JSON key (paste the full downloaded file contents)'}
                value={form.bqServiceAccountJson} onChange={(e) => setForm({ ...form, bqServiceAccountJson: e.target.value })} />
              <label className="col-span-2 flex items-center gap-2 text-sm text-neutral-600 dark:text-neutral-400">
                Max bytes billed per query
                <input className="w-40 rounded border p-1.5 text-sm dark:bg-neutral-900" type="number" min={1}
                  value={form.bqMaxBytesPerQuery} onChange={(e) => setForm({ ...form, bqMaxBytesPerQuery: e.target.value })} />
                <span className="text-xs text-neutral-500">
                  ({(Number(form.bqMaxBytesPerQuery) / 1024 ** 3).toFixed(2)} GiB — BigQuery rejects any query needing more, before billing anything)
                </span>
              </label>
              <label className="col-span-2 flex items-center gap-2 text-sm text-neutral-600 dark:text-neutral-400">
                Daily byte budget
                <input className="w-40 rounded border p-1.5 text-sm dark:bg-neutral-900" type="number" min={1}
                  value={form.bqDailyBytesBudget} onChange={(e) => setForm({ ...form, bqDailyBytesBudget: e.target.value })} />
                <span className="text-xs text-neutral-500">
                  ({(Number(form.bqDailyBytesBudget) / 1024 ** 3).toFixed(2)} GiB/day — cap for unattended dashboards/metrics/reports; a background refresh over the day&apos;s budget is skipped)
                </span>
              </label>
              <label className="col-span-2 flex items-center gap-2 text-sm text-neutral-600 dark:text-neutral-400">
                <input type="checkbox" checked={form.bqOfflineMode} onChange={(e) => setForm({ ...form, bqOfflineMode: e.target.checked })} />
                Offline mode
                <span className="text-xs text-neutral-500">
                  (dashboards/metrics/reports serve from a cached DuckDB snapshot — one budgeted extract, then $0 reads until it expires; data is stale between refreshes)
                </span>
              </label>
              <p className="col-span-2 text-xs text-neutral-500">
                Grant the service account only <code>roles/bigquery.dataViewer</code> + <code>roles/bigquery.jobUser</code> (no write role). Every query is dry-run estimated and confirmed before it runs.
              </p>
            </>
          ) : (
            <>
              <input className="rounded border p-2 dark:bg-neutral-900" placeholder="Host" value={form.host} onChange={(e) => setForm({ ...form, host: e.target.value })} />
              <input className="rounded border p-2 dark:bg-neutral-900" placeholder="Port" value={form.port} onChange={(e) => setForm({ ...form, port: e.target.value })} />
              <input className="rounded border p-2 dark:bg-neutral-900" placeholder="Database" value={form.database} onChange={(e) => setForm({ ...form, database: e.target.value })} />
              <input className="rounded border p-2 dark:bg-neutral-900" placeholder="User" value={form.user} onChange={(e) => setForm({ ...form, user: e.target.value })} />
              <input className="col-span-2 rounded border p-2 dark:bg-neutral-900" type="password" placeholder={editingId ? 'Password (blank = keep current)' : 'Password'} value={form.secret} onChange={(e) => setForm({ ...form, secret: e.target.value })} />
              <label className="col-span-2 flex items-center gap-2 text-sm text-neutral-600 dark:text-neutral-400">
                SSL/TLS
                <select value={form.ssl} onChange={(e) => setForm({ ...form, ssl: e.target.value as SslMode })}
                  className="rounded border p-1.5 text-sm dark:bg-neutral-900">
                  <option value="disable">Off (local / trusted network)</option>
                  <option value="require">Encrypt only — no cert check (most cloud DBs work)</option>
                  <option value="verify-full">Encrypt + verify certificate (MITM-proof)</option>
                </select>
              </label>
              {form.ssl === 'verify-full' && (
                <textarea className="col-span-2 rounded border p-2 font-mono text-xs dark:bg-neutral-900" rows={4}
                  placeholder={'CA certificate (PEM) — optional. Paste your provider\'s CA here if it uses a private CA (Supabase, Aiven…). Leave blank to verify against the system CA store.'}
                  value={form.sslCa} onChange={(e) => setForm({ ...form, sslCa: e.target.value })} />
              )}
              {form.engine === 'postgres' && (
                <input className="col-span-2 rounded border p-2 text-sm dark:bg-neutral-900"
                  placeholder="Postgres options (optional) — e.g. --cluster=my-cluster-1234 for CockroachDB"
                  value={form.options} onChange={(e) => setForm({ ...form, options: e.target.value })} />
              )}
              <label className="col-span-2 flex items-center gap-2 text-sm text-neutral-600 dark:text-neutral-400">
                <input type="checkbox" checked={form.sshOn} onChange={(e) => setForm({ ...form, sshOn: e.target.checked })} />
                Connect via SSH tunnel (database behind a bastion host)
              </label>
              {form.sshOn && (
                <>
                  <input className="rounded border p-2 dark:bg-neutral-900" placeholder="SSH host (bastion)" value={form.sshHost} onChange={(e) => setForm({ ...form, sshHost: e.target.value })} />
                  <input className="rounded border p-2 dark:bg-neutral-900" placeholder="SSH port (22)" value={form.sshPort} onChange={(e) => setForm({ ...form, sshPort: e.target.value })} />
                  <input className="rounded border p-2 dark:bg-neutral-900" placeholder="SSH user" value={form.sshUser} onChange={(e) => setForm({ ...form, sshUser: e.target.value })} />
                  <select value={form.sshAuthMethod} onChange={(e) => setForm({ ...form, sshAuthMethod: e.target.value as 'key' | 'password' })}
                    className="rounded border p-2 text-sm dark:bg-neutral-900">
                    <option value="key">Private key (PEM)</option>
                    <option value="password">Password</option>
                  </select>
                  {form.sshAuthMethod === 'key' ? (
                    <textarea className="col-span-2 rounded border p-2 font-mono text-xs dark:bg-neutral-900" rows={4}
                      placeholder={editingId ? 'SSH private key (PEM) — blank keeps the current one' : 'SSH private key (PEM), e.g. -----BEGIN OPENSSH PRIVATE KEY-----'}
                      value={form.sshSecret} onChange={(e) => setForm({ ...form, sshSecret: e.target.value })} />
                  ) : (
                    <input className="col-span-2 rounded border p-2 dark:bg-neutral-900" type="password"
                      placeholder={editingId ? 'SSH password — blank keeps current' : 'SSH password'}
                      value={form.sshSecret} onChange={(e) => setForm({ ...form, sshSecret: e.target.value })} />
                  )}
                </>
              )}
            </>
          )}
        </div>

        <div className="mt-3 flex items-center gap-2">
          {!isSqlite && <button onClick={test} disabled={busy || (isBigQuery ? !form.bqProjectId : !form.host)} className="rounded border px-4 py-2 text-sm disabled:opacity-50">Test connection</button>}
          <button onClick={save} disabled={busy || !form.name} className="rounded bg-blue-600 px-4 py-2 text-white disabled:opacity-50">
            {busy ? 'Working…' : editingId ? 'Save & re-sync' : 'Add & sync schema'}
          </button>
        </div>
        {msg && <p className="mt-2 text-sm">{msg}</p>}
      </div>

      <h2 className="mb-2 font-medium">Connections</h2>
      <ul className="space-y-2">
        {conns.map((c) => (
          <li key={c.id} className="flex items-center justify-between rounded border border-neutral-200 p-3 dark:border-neutral-800">
            <div>
              <span className="font-medium">{c.name}</span>
              <span className="ml-2 text-xs text-neutral-500">{c.dialect}</span>
              <span className={`ml-2 text-xs ${c.isReadOnlyVerified ? 'text-green-600' : 'text-amber-600'}`}>
                {c.isReadOnlyVerified ? 'read-only ✓' : 'writable ⚠'}
              </span>
            </div>
            <div className="flex gap-2">
              <Link href={`/db/${c.id}/chat`} className="rounded bg-neutral-800 px-3 py-1 text-sm text-white dark:bg-neutral-200 dark:text-neutral-900">Chat</Link>
              <Link href={`/db/${c.id}/schema`} className="rounded border px-3 py-1 text-sm">Browse</Link>
              <Link href={`/db/${c.id}/context`} className="rounded border px-3 py-1 text-sm">Context</Link>
              <Link href={`/db/${c.id}/accelerator`} className="rounded border px-3 py-1 text-sm">⚡ Accelerator</Link>
              <button onClick={() => editConn(c)} className="rounded border px-3 py-1 text-sm">Edit</button>
              <button onClick={() => remove(c.id)} className="rounded border px-3 py-1 text-sm">Delete</button>
            </div>
          </li>
        ))}
        {!loaded && <li className="text-sm text-neutral-400">Loading…</li>}
        {loaded && conns.length === 0 && (
          <li className="rounded border border-dashed border-neutral-300 p-6 text-center text-sm text-neutral-500 dark:border-neutral-700">
            <p className="mb-3">No connections yet. Add your database above — or explore with a sample one first:</p>
            <button onClick={tryDemo} disabled={busy}
              className="rounded bg-blue-600 px-4 py-2 text-white disabled:opacity-50">
              {busy ? 'Setting up…' : '✨ Try with a sample database'}
            </button>
            <p className="mt-2 text-xs">Creates a small local shop DB (orders, products, customers) with a pre-seeded business glossary.</p>
          </li>
        )}
      </ul>
    </main>
  );
}
