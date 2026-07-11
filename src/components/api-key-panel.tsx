'use client';

import { useEffect, useState } from 'react';
import { CopyButton } from './copy-button';

interface ApiKey { id: string; name: string; connectionId: string | null; maxTier: string; lastUsedAt: string | null; revokedAt: string | null; createdAt: string }
interface Conn { id: string; name: string }

/** API keys for the MCP server / HTTP API. The raw token is shown exactly once
 *  at creation (only a hash is stored) — copy it immediately. */
export function ApiKeyPanel() {
  const [keys, setKeys] = useState<ApiKey[]>([]);
  const [conns, setConns] = useState<Conn[]>([]);
  const [f, setF] = useState({ name: '', connectionId: '', maxTier: 'low' });
  const [freshToken, setFreshToken] = useState<string | null>(null);

  async function load() {
    setKeys(await (await fetch('/api/api-keys')).json());
    setConns(await (await fetch('/api/connections')).json());
  }
  useEffect(() => { load(); }, []);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    const r = await fetch('/api/api-keys', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: f.name, connectionId: f.connectionId || undefined, maxTier: f.maxTier }),
    });
    const d = await r.json();
    setFreshToken(d.token ?? d.rawKey ?? d.key ?? null);
    setF({ name: '', connectionId: '', maxTier: 'low' });
    load();
  }

  async function revoke(id: string) {
    if (!confirm('Revoke this key? Clients using it stop working immediately.')) return;
    await fetch(`/api/api-keys?id=${id}`, { method: 'DELETE' });
    load();
  }

  const connName = (id: string | null) => conns.find((c) => c.id === id)?.name ?? 'all connections';

  return (
    <section className="rounded border border-neutral-200 p-4 dark:border-neutral-800">
      <h2 className="mb-1 text-sm font-semibold">API keys (MCP / HTTP API)</h2>
      <p className="mb-3 text-xs text-neutral-500">Auth for the MCP server and the HTTP API. The key is shown <b>once</b> at creation — only a hash is stored.</p>

      <form onSubmit={create} className="mb-3 flex flex-wrap items-center gap-2 text-sm">
        <input className="min-w-40 flex-1 rounded border p-2 dark:bg-neutral-900" placeholder="Key name (e.g. claude-desktop)" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
        <select className="rounded border p-2 text-xs dark:bg-neutral-900" value={f.connectionId} onChange={(e) => setF({ ...f, connectionId: e.target.value })}>
          <option value="">Scope: all connections</option>
          {conns.map((c) => <option key={c.id} value={c.id}>Scope: {c.name}</option>)}
        </select>
        <select className="rounded border p-2 text-xs dark:bg-neutral-900" value={f.maxTier} onChange={(e) => setF({ ...f, maxTier: e.target.value })} title="Max risk tier this key may auto-run">
          <option value="low">Max tier: low</option>
          <option value="medium">Max tier: medium</option>
        </select>
        <button className="rounded bg-blue-600 px-3 py-2 text-white disabled:opacity-50" disabled={!f.name.trim()}>Create key</button>
      </form>

      {freshToken && (
        <div className="mb-3 rounded border border-green-300 bg-green-50 p-2 text-xs dark:bg-green-950/30">
          <div className="mb-1 font-medium text-green-700 dark:text-green-400">Copy this key now — it will not be shown again:</div>
          <div className="flex items-center gap-2">
            <code className="min-w-0 flex-1 truncate">{freshToken}</code>
            <CopyButton label="Copy key" getText={() => freshToken} />
            <button onClick={() => setFreshToken(null)} className="text-neutral-400">✕</button>
          </div>
        </div>
      )}

      <ul className="space-y-1 text-xs">
        {keys.length === 0 && <li className="text-neutral-500">No keys yet.</li>}
        {keys.map((k) => (
          <li key={k.id} className="flex items-center justify-between rounded border border-neutral-200 p-2 dark:border-neutral-800">
            <span className={k.revokedAt ? 'line-through opacity-50' : ''}>
              <b>{k.name}</b> · {connName(k.connectionId)} · tier {k.maxTier}
              {k.lastUsedAt && <span className="text-neutral-400"> · last used {new Date(k.lastUsedAt).toLocaleDateString()}</span>}
            </span>
            {!k.revokedAt && <button onClick={() => revoke(k.id)} className="text-red-600">Revoke</button>}
            {k.revokedAt && <span className="text-neutral-400">revoked</span>}
          </li>
        ))}
      </ul>

      <details className="mt-3 text-xs">
        <summary className="cursor-pointer font-medium">Connect Claude / Cursor (MCP)</summary>
        <pre className="mt-2 overflow-x-auto rounded bg-neutral-100 p-2 dark:bg-neutral-900">{`claude mcp add my-db-mate -- npx tsx scripts/mcp-server-entry.ts
# env cần thiết:
#   MDM_API_KEY=<key vừa tạo>
#   DATABASE_URL=<postgres của app>
#   OPENROUTER_API_KEY=<hoặc provider đã cấu hình ở trên>`}</pre>
        <p className="mt-1 text-neutral-500">Chi tiết: docs/agent-setup.md</p>
      </details>
    </section>
  );
}
