'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { DEFAULT_PORT, kindForEngine, parseConnectionString, type Engine } from '../../lib/connection-config';

interface Conn { id: string; name: string; kind: string; dialect: string; isReadOnlyVerified: boolean; config: Record<string, unknown> }

const BLANK = { name: '', engine: 'postgres' as Engine, path: '', host: 'localhost', port: '5432', database: '', user: '', secret: '', ssl: false };

export default function ConnectionsPage() {
  const [conns, setConns] = useState<Conn[]>([]);
  const [form, setForm] = useState({ ...BLANK });
  const [editingId, setEditingId] = useState<string | null>(null);
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);

  const load = () => fetch('/api/connections').then((r) => r.json()).then(setConns);
  useEffect(() => { load(); }, []);

  /** Switching engine sets the conventional default port (like DBeaver). */
  function setEngine(engine: Engine) {
    setForm((f) => ({ ...f, engine, port: engine === 'sqlite' ? '' : String(DEFAULT_PORT[engine]) }));
  }

  /** Paste a connection URL → fill the fields (postgres://… / mysql://…). */
  function pasteUrl(raw: string) {
    if (!raw.trim()) return;
    try {
      const p = parseConnectionString(raw);
      setForm((f) => ({ ...f, engine: p.engine, host: p.host, port: String(p.port), database: p.database, user: p.user, secret: p.password, ssl: p.ssl === 'require' }));
      setMsg('Filled from connection string.');
    } catch (e) {
      setMsg(`Could not parse URL: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  function buildBody() {
    const kind = kindForEngine(form.engine);
    const config = form.engine === 'sqlite'
      ? { path: form.path }
      : { host: form.host, port: Number(form.port), database: form.database, user: form.user, ssl: form.ssl ? 'require' : 'disable' };
    return { name: form.name, kind, dialect: form.engine, config, secret: form.engine === 'sqlite' ? undefined : form.secret };
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
      ssl: cfg.ssl === 'require',
    });
    setMsg('Editing — leave password blank to keep the current one.');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function resetForm() { setEditingId(null); setForm({ ...BLANK }); }

  async function remove(id: string) {
    await fetch(`/api/connections/${id}`, { method: 'DELETE' });
    if (editingId === id) resetForm();
    load();
  }

  const isSqlite = form.engine === 'sqlite';

  return (
    <main className="mx-auto max-w-3xl p-6">
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-2xl font-semibold">My DB Mate — Connections</h1>
        <Link href="/dashboards" className="text-sm text-blue-600">Dashboards →</Link>
      </div>

      <div className="mb-6 rounded-lg border border-neutral-300 p-4 dark:border-neutral-700">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="font-medium">{editingId ? 'Edit connection' : 'Add connection'}</h2>
          {editingId && <button onClick={resetForm} className="text-xs text-blue-600">+ New instead</button>}
        </div>

        {/* Engine picker */}
        <div className="mb-3 flex gap-2">
          {(['postgres', 'mysql', 'sqlite'] as Engine[]).map((e) => (
            <button key={e} onClick={() => setEngine(e)} disabled={!!editingId}
              className={`rounded border px-3 py-1.5 text-sm capitalize disabled:opacity-50 ${form.engine === e ? 'border-blue-600 bg-blue-50 font-medium text-blue-700 dark:bg-blue-950 dark:text-blue-300' : ''}`}>
              {e === 'postgres' ? '🐘 PostgreSQL' : e === 'mysql' ? '🐬 MySQL' : '📄 SQLite'}
            </button>
          ))}
        </div>

        {/* Connection-string paste (TCP only) */}
        {!isSqlite && !editingId && (
          <input className="mb-2 w-full rounded border p-2 text-sm dark:bg-neutral-900"
            placeholder="Paste connection string (postgres://user:pass@host:5432/db?sslmode=require) — optional"
            onChange={(e) => pasteUrl(e.target.value)} />
        )}

        <div className="grid grid-cols-2 gap-2">
          <input className="col-span-2 rounded border p-2 dark:bg-neutral-900" placeholder="Name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          {isSqlite ? (
            <input className="col-span-2 rounded border p-2 dark:bg-neutral-900" placeholder="Absolute path to .db" value={form.path} onChange={(e) => setForm({ ...form, path: e.target.value })} />
          ) : (
            <>
              <input className="rounded border p-2 dark:bg-neutral-900" placeholder="Host" value={form.host} onChange={(e) => setForm({ ...form, host: e.target.value })} />
              <input className="rounded border p-2 dark:bg-neutral-900" placeholder="Port" value={form.port} onChange={(e) => setForm({ ...form, port: e.target.value })} />
              <input className="rounded border p-2 dark:bg-neutral-900" placeholder="Database" value={form.database} onChange={(e) => setForm({ ...form, database: e.target.value })} />
              <input className="rounded border p-2 dark:bg-neutral-900" placeholder="User" value={form.user} onChange={(e) => setForm({ ...form, user: e.target.value })} />
              <input className="col-span-2 rounded border p-2 dark:bg-neutral-900" type="password" placeholder={editingId ? 'Password (blank = keep current)' : 'Password'} value={form.secret} onChange={(e) => setForm({ ...form, secret: e.target.value })} />
              <label className="col-span-2 flex items-center gap-2 text-sm text-neutral-600 dark:text-neutral-400">
                <input type="checkbox" checked={form.ssl} onChange={(e) => setForm({ ...form, ssl: e.target.checked })} />
                Use SSL/TLS (required by most cloud DBs — Neon, Supabase, RDS, PlanetScale)
              </label>
            </>
          )}
        </div>

        <div className="mt-3 flex items-center gap-2">
          {!isSqlite && <button onClick={test} disabled={busy || !form.host} className="rounded border px-4 py-2 text-sm disabled:opacity-50">Test connection</button>}
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
              <Link href={`/chat/${c.id}`} className="rounded bg-neutral-800 px-3 py-1 text-sm text-white dark:bg-neutral-200 dark:text-neutral-900">Chat</Link>
              <Link href={`/browse/${c.id}`} className="rounded border px-3 py-1 text-sm">Browse</Link>
              <Link href={`/context-studio/${c.id}`} className="rounded border px-3 py-1 text-sm">Context</Link>
              <button onClick={() => editConn(c)} className="rounded border px-3 py-1 text-sm">Edit</button>
              <button onClick={() => remove(c.id)} className="rounded border px-3 py-1 text-sm">Delete</button>
            </div>
          </li>
        ))}
        {conns.length === 0 && <li className="text-sm text-neutral-500">No connections yet.</li>}
      </ul>
    </main>
  );
}
