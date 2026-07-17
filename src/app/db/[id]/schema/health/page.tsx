'use client';

import { use, useEffect, useState, useCallback } from 'react';
import Link from 'next/link';

interface Flag { tableName: string; columnName: string; issue: string; detail: string }
interface Health { flags: Flag[]; profiledColumns: number; totalColumns: number }
interface MonitorRun { id: string; status: string; detail: string | null; ranAt: string; result: { columns: string[]; rows: unknown[][] } | null }
interface SchemaCol { tableName: string; columnName: string; dataType: string }
interface AnomalyReport { table: string; column: string; total: number; nullRate: number; numeric?: { avg: number; stddev: number; min: string; max: string; outlierCount: number }; note?: string }

// isNumericType isn't exported anywhere — inline check against synced dataType.
const NUMERIC_RE = /int|numeric|real|float|double|decimal|money/i;

/** The anomaly service wraps DB-derived min/max in `<data>…</data>` so the agent can't
 *  read them as instructions. That guard is for the agent path; when rendering the
 *  min/max to the user here, strip the wrapper so the number shows plainly. */
function unwrapData(v: string): string {
  return v.replace(/^<data>([\s\S]*)<\/data>$/, '$1');
}

const ISSUE_LABEL: Record<string, string> = {
  high_null: '⚠ High NULL rate',
  single_value: '① Single value',
  near_unique: '🔑 Near-unique (id-like)',
};

export default function DataHealthPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [monitorRuns, setMonitorRuns] = useState<MonitorRun[]>([]);
  const [numericCols, setNumericCols] = useState<SchemaCol[]>([]);
  const [anomaly, setAnomaly] = useState<AnomalyReport | { error: string } | null>(null);
  const [anomalyBusy, setAnomalyBusy] = useState('');
  useEffect(() => {
    fetch(`/api/connections/${id}/schema`).then((r) => r.json()).then((d) => {
      const cols: SchemaCol[] = [];
      for (const t of d.tables ?? []) {
        for (const c of t.columns ?? []) {
          if (NUMERIC_RE.test(c.dataType) && !c.isPrimaryKey) cols.push({ tableName: t.tableName, columnName: c.columnName, dataType: c.dataType });
        }
      }
      setNumericCols(cols);
    }).catch(() => {});
  }, [id]);

  async function checkAnomalies(table: string, column: string) {
    setAnomalyBusy(`${table}.${column}`);
    setAnomaly(null);
    const r = await fetch(`/api/connections/${id}/anomaly`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ table, column }),
    });
    setAnomaly(await r.json());
    setAnomalyBusy('');
  }
  useEffect(() => {
    fetch(`/api/connections/${id}/schedules/runs?mode=monitor`).then((r) => r.json())
      .then((runs) => setMonitorRuns(Array.isArray(runs) ? runs.slice(0, 3) : []))
      .catch(() => {});
  }, [id]);
  const [health, setHealth] = useState<Health | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');

  const load = useCallback(async () => {
    setHealth(await (await fetch(`/api/connections/${id}/data-health`)).json());
  }, [id]);
  useEffect(() => { load(); }, [load]);

  async function profile() {
    setBusy(true); setMsg('Profiling (this runs inline and may take a moment)…');
    const r = await fetch(`/api/connections/${id}/data-health`, { method: 'POST' });
    const d = await r.json();
    setMsg(`Profiled ${d.scanned} column(s)${d.failed ? `, ${d.failed} failed` : ''}.`);
    setBusy(false);
    load();
  }

  const partial = health && health.profiledColumns > 0 && health.profiledColumns < health.totalColumns;

  return (
    <main className="mx-auto max-w-3xl p-6">
      <div className="mb-3 flex items-center justify-between">
        <h1 className="text-lg font-semibold">Data Health</h1>
        <Link href={`/db/${id}/schema`} className="text-sm text-blue-600">← Browse</Link>
      </div>
      <div className="mb-3 flex items-center gap-3">
        <button onClick={profile} disabled={busy} className="rounded bg-blue-600 px-4 py-2 text-sm text-white disabled:opacity-50">{busy ? 'Profiling…' : 'Profile data quality'}</button>
        {msg && <span className="text-xs text-neutral-500">{msg}</span>}
      </div>

      {!health ? (
        <p className="text-sm text-neutral-500">Loading…</p>
      ) : health.profiledColumns === 0 ? (
        <p className="text-sm text-neutral-500">Not profiled yet — click “Profile data quality”.</p>
      ) : (
        <>
          <p className="mb-3 text-xs text-neutral-400">
            Profiled {health.profiledColumns} of {health.totalColumns} columns.
            {partial && <span className="ml-1 text-amber-600">Partial scan — some columns not profiled.</span>}
          </p>
          {health.flags.length === 0 ? (
            <p className="text-sm text-green-600">No data-quality issues flagged in the profiled columns.</p>
          ) : (
            <ul className="space-y-1 text-sm">
              {health.flags.map((f, i) => (
                <li key={i} className="flex items-center justify-between gap-2 rounded border border-neutral-200 p-2 dark:border-neutral-800">
                  <span className="font-mono text-xs">{f.tableName}.{f.columnName}</span>
                  <span className="min-w-0 flex-1 text-right text-xs">{ISSUE_LABEL[f.issue] ?? f.issue} · {f.detail}</span>
                  <Link className="shrink-0 text-xs text-blue-600 hover:underline"
                    href={`/db/${id}/chat?q=${encodeURIComponent(`Column ${f.columnName} in table ${f.tableName} was flagged: ${ISSUE_LABEL[f.issue] ?? f.issue} (${f.detail}). Investigate whether this is a data problem and what it means.`)}`}>
                    Ask agent →
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
          {numericCols.length > 0 && (
        <section className="mt-6" data-testid="anomaly-check">
          <h2 className="mb-2 text-sm font-semibold">🔬 Check anomalies (không cần chat)</h2>
          <div className="flex max-h-40 flex-wrap gap-2 overflow-y-auto text-xs">
            {numericCols.map((c) => (
              <button key={`${c.tableName}.${c.columnName}`} onClick={() => checkAnomalies(c.tableName, c.columnName)}
                disabled={anomalyBusy !== ''}
                className="rounded border px-2 py-1 font-mono hover:border-blue-500 disabled:opacity-50">
                {anomalyBusy === `${c.tableName}.${c.columnName}` ? '…' : `${c.tableName}.${c.columnName}`}
              </button>
            ))}
          </div>
          {anomaly && 'error' in anomaly && <p className="mt-2 text-xs text-red-600">{anomaly.error}</p>}
          {anomaly && !('error' in anomaly) && (
            <div className="mt-2 rounded border border-neutral-200 p-2 text-xs dark:border-neutral-800" data-testid="anomaly-report">
              <b className="font-mono">{anomaly.table}.{anomaly.column}</b> · {anomaly.total.toLocaleString()} rows · null {Math.round(anomaly.nullRate * 1000) / 10}%
              {anomaly.numeric && (
                <> · avg {Math.round(anomaly.numeric.avg * 100) / 100} · σ {Math.round(anomaly.numeric.stddev * 100) / 100} · range [{unwrapData(anomaly.numeric.min)} … {unwrapData(anomaly.numeric.max)}] · <b>{anomaly.numeric.outlierCount} outliers (±3σ)</b></>
              )}
              {anomaly.note && <p className="mt-1 text-neutral-500">{anomaly.note}</p>}
              <Link className="ml-2 text-blue-600 hover:underline"
                href={`/db/${id}/chat?q=${encodeURIComponent(`Column ${anomaly.column} in ${anomaly.table}: ${anomaly.numeric?.outlierCount ?? 0} outliers beyond 3 sigma, null rate ${Math.round(anomaly.nullRate * 100)}%. Investigate what these outliers are and whether they are a data problem.`)}`}>
                Ask agent →</Link>
            </div>
          )}
        </section>
      )}
      {monitorRuns.length > 0 && (
        <section className="mt-6" data-testid="monitor-findings">
          <h2 className="mb-2 text-sm font-semibold">🔎 Monitor findings gần nhất</h2>
          <ul className="space-y-1 text-xs">
            {monitorRuns.map((r) => (
              <li key={r.id} className={`rounded border p-2 ${r.result?.rows?.length ? 'border-amber-300 bg-amber-50 dark:bg-amber-950/30' : 'border-neutral-200 dark:border-neutral-800'}`}>
                <span className="text-neutral-500">{new Date(r.ranAt).toLocaleString()}</span> · {r.detail ?? r.status}
              </li>
            ))}
          </ul>
        </section>
      )}
    </main>
  );
}
