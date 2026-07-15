'use client';

import { use, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { IncrementalRefreshControl } from '../../../../components/incremental-refresh-control';

interface Conn { id: string; accelerateEnabled: boolean; accelerateTtlMs: number | null }
interface Snapshot {
  id: string;
  cacheKey: string;
  sql: string;
  asOf: string | null;
  sizeBytes: number | null;
  status: string;
  lastError: string | null;
  updatedAt: string;
}
interface WatermarkConfig { id: string; tableName: string; watermarkCol: string }
interface SchemaTable { tableName: string }

function fmtBytes(n: number | null) {
  if (n == null) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export default function AcceleratorPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();

  const [conn, setConn] = useState<Conn | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [ttlMinutes, setTtlMinutes] = useState('60');
  const [savingSettings, setSavingSettings] = useState(false);
  const [settingsMsg, setSettingsMsg] = useState('');

  const [snapshots, setSnapshots] = useState<Snapshot[] | null>(null);
  const [refreshingKey, setRefreshingKey] = useState<string | null>(null);

  const [tables, setTables] = useState<SchemaTable[]>([]);
  const [watermarkConfigs, setWatermarkConfigs] = useState<WatermarkConfig[]>([]);
  const [selectedTable, setSelectedTable] = useState('');

  const loadConn = () =>
    fetch(`/api/connections/${id}`).then((r) => r.json()).then((c: Conn) => {
      setConn(c);
      setEnabled(Boolean(c.accelerateEnabled));
      setTtlMinutes(String(Math.round((c.accelerateTtlMs ?? 60 * 60_000) / 60_000)));
    });
  const loadSnapshots = () =>
    fetch(`/api/connections/${id}/accelerator/snapshots`).then((r) => r.json()).then(setSnapshots);
  const loadWatermarkConfigs = () =>
    fetch(`/api/connections/${id}/watermark-config`).then((r) => r.json()).then(setWatermarkConfigs);

  useEffect(() => {
    loadConn();
    loadSnapshots();
    loadWatermarkConfigs();
    fetch(`/api/connections/${id}/schema`).then((r) => r.json()).then((d) => setTables(d.tables ?? []));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  async function saveSettings() {
    setSavingSettings(true); setSettingsMsg('');
    const res = await fetch(`/api/connections/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({
        accelerateEnabled: enabled,
        accelerateTtlMs: enabled && ttlMinutes.trim() ? Math.round(Number(ttlMinutes) * 60_000) : null,
      }),
    });
    const d = await res.json();
    if (!res.ok) setSettingsMsg(`Error: ${d.error}`);
    else {
      setSettingsMsg('Saved ✓');
      loadConn();
      // WorkspaceRail's tab styling comes from a prop the parent server layout
      // fetched once — refresh it so enabling/disabling here updates the tab
      // immediately instead of only after the next hard navigation.
      router.refresh();
    }
    setSavingSettings(false);
  }

  async function refreshSnapshot(cacheKey: string) {
    setRefreshingKey(cacheKey);
    await fetch(`/api/connections/${id}/accelerator/snapshots/refresh`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cacheKey }),
    });
    await loadSnapshots();
    setRefreshingKey(null);
  }

  if (!conn) return <main className="p-6 text-sm text-neutral-500">Loading…</main>;

  return (
    <main className="mx-auto max-w-4xl space-y-8 p-6">
      <h1 className="text-2xl font-semibold">⚡ Accelerator</h1>

      <section className="rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
        <h2 className="mb-3 font-medium">Settings</h2>
        <label className="mb-3 flex items-center gap-2 text-sm text-neutral-600 dark:text-neutral-400">
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
          Enable query accelerator (routes heavy queries through a cached DuckDB/Parquet snapshot)
        </label>
        {enabled && (
          <label className="mb-3 flex items-center gap-2 text-sm text-neutral-600 dark:text-neutral-400">
            Snapshot cache TTL (minutes)
            <input className="w-24 rounded border p-1.5 text-sm dark:bg-neutral-900" placeholder="60"
              value={ttlMinutes} onChange={(e) => setTtlMinutes(e.target.value)} />
          </label>
        )}
        <button onClick={saveSettings} disabled={savingSettings} className="rounded bg-blue-600 px-4 py-2 text-sm text-white disabled:opacity-50">
          {savingSettings ? 'Saving…' : 'Save'}
        </button>
        {settingsMsg && <p className="mt-2 text-sm">{settingsMsg}</p>}
      </section>

      <section className="rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
        <h2 className="mb-3 font-medium">Snapshots</h2>
        {!snapshots || snapshots.length === 0 ? (
          <p className="text-sm text-neutral-500">No snapshots yet — created the first time a heavy query hits an accelerated table.</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-neutral-500">
                <th className="py-1">SQL</th>
                <th>As of</th>
                <th>Size</th>
                <th>Status</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {snapshots.map((s) => (
                <tr key={s.id} className="border-t border-neutral-100 align-top dark:border-neutral-800">
                  <td className="max-w-xs truncate py-1.5 font-mono text-xs" title={s.sql}>{s.sql}</td>
                  <td className="whitespace-nowrap text-xs">{s.asOf ? new Date(s.asOf).toLocaleString() : '—'}</td>
                  <td className="whitespace-nowrap text-xs">{fmtBytes(s.sizeBytes)}</td>
                  <td className="text-xs">
                    <span className={s.status === 'ready' ? 'text-green-600' : s.status === 'failed' ? 'text-red-600' : 'text-amber-600'}>{s.status}</span>
                    {s.lastError && <div className="mt-0.5 max-w-xs truncate text-red-500" title={s.lastError}>{s.lastError}</div>}
                  </td>
                  <td>
                    <button onClick={() => refreshSnapshot(s.cacheKey)} disabled={refreshingKey === s.cacheKey}
                      className="rounded border px-2 py-0.5 text-xs hover:bg-neutral-100 disabled:opacity-50 dark:hover:bg-neutral-800">
                      {refreshingKey === s.cacheKey ? 'Refreshing…' : 'Refresh'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
        <h2 className="mb-3 font-medium">Incremental refresh (watermark config)</h2>
        {watermarkConfigs.length > 0 && (
          <ul className="mb-3 space-y-0.5 text-xs text-neutral-500">
            {watermarkConfigs.map((c) => (
              <li key={c.id}>
                <span className="font-mono">{c.tableName}</span> → <span className="font-mono">{c.watermarkCol}</span>
              </li>
            ))}
          </ul>
        )}
        <div className="mb-3 flex items-center gap-2">
          <select value={selectedTable} onChange={(e) => setSelectedTable(e.target.value)}
            className="rounded border p-1.5 text-sm dark:bg-neutral-900">
            <option value="">Configure a table…</option>
            {tables.map((t) => <option key={t.tableName} value={t.tableName}>{t.tableName}</option>)}
          </select>
        </div>
        {selectedTable && (
          <IncrementalRefreshControl connectionId={id} tableName={selectedTable} />
        )}
      </section>
    </main>
  );
}
