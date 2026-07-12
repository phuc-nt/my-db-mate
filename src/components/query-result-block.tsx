'use client';

import { useEffect, useState } from 'react';
import { CopyButton } from './copy-button';
import { FormModal, type FormModalField } from './form-modal';
import { ResultTable } from './result-table';
import type { ExportDialect } from '../lib/export-formats';

interface RunResult {
  columns: string[];
  rows: unknown[][];
  executedSql?: string;
}

/**
 * Renders one `run_sql` tool call from the chat: the executed SQL (editable) with
 * a Re-run button that goes through the same safety choke point (/execute), plus
 * the result table + CSV export. `blocked`/`error` states are shown inline.
 */
export function QueryResultBlock({
  connectionId,
  sessionId,
  initialSql,
  initialResult,
  initialBlockedReason,
  initialError,
  dialect,
  onConfirmedRun,
}: {
  connectionId: string;
  sessionId?: string;
  initialSql: string;
  initialResult?: RunResult;
  initialBlockedReason?: string;
  initialError?: string;
  dialect?: ExportDialect;
  /** Fired after a "Confirm & run anyway" succeeds — the chat page records the
   *  result into the transcript (the agent never sees manual executions). */
  onConfirmedRun?: (info: { sql: string; columns: string[]; rows: unknown[][] }) => void;
}) {
  const [sql, setSql] = useState(initialSql);
  const [result, setResult] = useState<RunResult | undefined>(initialResult);
  const [blocked, setBlocked] = useState(initialBlockedReason);
  const [error, setError] = useState(initialError);
  const [busy, setBusy] = useState(false);
  // The SQL that actually executed (result.executedSql), NOT the editable buffer
  // — RT-F12: never save an unrun/edited buffer as a "verified" query.
  const [lastExecutedSql, setLastExecutedSql] = useState(initialResult?.executedSql);
  const [saveMsg, setSaveMsg] = useState('');
  const [confirmRisk, setConfirmRisk] = useState<{ tier: string; reason: string } | undefined>();
  // Which save-action dialog is open (replaces the old chained window.prompt flows).
  const [modal, setModal] = useState<null | 'verified' | 'bookmark' | 'pin' | 'schedule'>(null);
  // Per-connection SQL visibility default (localStorage — deliberately NOT in
  // connections.config: the edit form rebuilds config from an allowlist and
  // would silently drop extra keys). 'expanded' keeps today's behavior.
  const [sqlShown, setSqlShown] = useState(true);
  useEffect(() => {
    setSqlShown(localStorage.getItem(`mdm.sqlDisplay.${connectionId}`) !== 'on-demand');
  }, [connectionId]);
  function toggleSqlDefault() {
    setSqlShown((cur) => {
      const next = !cur;
      localStorage.setItem(`mdm.sqlDisplay.${connectionId}`, next ? 'expanded' : 'on-demand');
      return next;
    });
  }

  async function rerun(confirmed = false) {
    setBusy(true);
    setBlocked(undefined);
    setError(undefined);
    setSaveMsg('');
    setConfirmRisk(undefined);
    try {
      const res = await fetch(`/api/connections/${connectionId}/execute`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sql, sessionId, confirmed }),
      });
      const data = await res.json();
      if (data.status === 'blocked') { setBlocked(data.reason); setResult(undefined); }
      else if (data.status === 'needs_confirmation') { setConfirmRisk(data.risk); setResult(undefined); }
      else if (data.status === 'error') { setError(data.error); setResult(undefined); }
      else {
        setResult({ columns: data.columns, rows: data.rows, executedSql: data.executedSql });
        setLastExecutedSql(data.executedSql);
        if (confirmed) onConfirmedRun?.({ sql: data.executedSql ?? sql, columns: data.columns, rows: data.rows });
      }
    } catch (e) {
      setError(String(e));
    }
    setBusy(false);
  }

  async function saveVerified(question: string) {
    if (!question || !lastExecutedSql) return;
    const r = await fetch(`/api/connections/${connectionId}/context`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'verified_query', question, sql: lastExecutedSql }),
    });
    setSaveMsg(r.ok ? 'Saved to verified queries ✓' : 'save failed');
  }

  /** Bookmark the executed SQL for quick 1-click re-run later. */
  async function bookmark(name: string) {
    if (!lastExecutedSql || !name) return;
    const r = await fetch(`/api/connections/${connectionId}/bookmarks`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name, sql: lastExecutedSql }),
    });
    setSaveMsg(r.ok ? `Bookmarked "${name}" ✓` : 'bookmark failed');
  }

  /** Pin this executed result to a dashboard (create-or-reuse by name). */
  async function pin(dashName: string, title: string) {
    if (!lastExecutedSql || !dashName) return;
    // Find existing dashboard by name or create one.
    const list = await (await fetch('/api/dashboards')).json();
    let dash = (list as { id: string; name: string }[]).find((d) => d.name === dashName);
    if (!dash) dash = await (await fetch('/api/dashboards', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: dashName }) })).json();
    const r = await fetch(`/api/dashboards/${dash!.id}/widgets`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ connectionId, title, sql: lastExecutedSql }),
    });
    const data = await r.json();
    setSaveMsg(data.widgetId ? `Pinned to "${dashName}" ✓` : `pin failed: ${data.error ?? 'error'}`);
  }

  /** Schedule the executed SQL as a recurring job (daily by default; edit in
   *  the Automations tab). Goes through the schedules API — cron validated and
   *  webhook SSRF-vetted server-side. */
  async function schedule(name: string, cronExpr: string) {
    if (!lastExecutedSql || !name || !cronExpr) return;
    const r = await fetch(`/api/connections/${connectionId}/schedules`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'create', name, mode: 'sql', sql: lastExecutedSql, cron: cronExpr }),
    });
    const d = await r.json();
    setSaveMsg(r.ok ? `Scheduled "${name}" ✓ — manage in Automations` : `schedule failed: ${d.error ?? 'error'}`);
  }

  return (
    <div className="mt-2 rounded border border-neutral-200 p-2 text-xs dark:border-neutral-800">
      <div className="mb-1 flex items-center justify-between font-medium text-neutral-500">
        <span>SQL</span>
        <button onClick={toggleSqlDefault} className="text-[11px] text-blue-600 hover:underline" title="Default for this connection" data-testid="sql-visibility-toggle">
          {sqlShown ? 'Hide SQL by default' : 'Show SQL'}
        </button>
      </div>
      {sqlShown && (
        <textarea
          className="w-full resize-y rounded border border-neutral-300 bg-neutral-50 p-2 font-mono text-xs dark:border-neutral-700 dark:bg-neutral-900"
          rows={Math.min(6, sql.split('\n').length + 1)}
          value={sql}
          onChange={(e) => setSql(e.target.value)}
        />
      )}
      <div className="mt-1 flex items-center gap-2">
        <button onClick={() => rerun(false)} disabled={busy} className="rounded bg-neutral-800 px-3 py-1 text-white disabled:opacity-50 dark:bg-neutral-200 dark:text-neutral-900">
          {busy ? 'Running…' : 'Re-run'}
        </button>
        <CopyButton label="Copy SQL" getText={() => sql} />
        {lastExecutedSql && result && (
          <>
            <button onClick={() => setModal('verified')} className="rounded border px-3 py-1 hover:bg-neutral-100 dark:hover:bg-neutral-800">Save as verified query</button>
            <button onClick={() => setModal('bookmark')} className="rounded border px-3 py-1 hover:bg-neutral-100 dark:hover:bg-neutral-800">⭐ Bookmark</button>
            <button onClick={() => setModal('pin')} className="rounded border px-3 py-1 hover:bg-neutral-100 dark:hover:bg-neutral-800">📌 Pin to dashboard</button>
            <button onClick={() => setModal('schedule')} className="rounded border px-3 py-1 hover:bg-neutral-100 dark:hover:bg-neutral-800">⏰ Schedule</button>
          </>
        )}
        {saveMsg && <span className="text-green-600">{saveMsg}</span>}
      </div>
      {confirmRisk && (
        <div className="mt-1 rounded border border-amber-300 bg-amber-50 p-2 text-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
          <div>⚠ {confirmRisk.tier}-risk query: {confirmRisk.reason}</div>
          <button onClick={() => rerun(true)} disabled={busy} className="mt-1 rounded bg-amber-600 px-3 py-1 text-white">Confirm & run anyway</button>
        </div>
      )}
      {blocked && <p className="mt-1 text-amber-600">Blocked: {blocked}</p>}
      {error && <p className="mt-1 text-red-600">Error: {error}</p>}
      {result && <ResultTable columns={result.columns} rows={result.rows} dialect={dialect} />}

      {(() => {
        const cfg: Record<string, { title: string; submitLabel: string; fields: FormModalField[]; run: (v: Record<string, string>) => void }> = {
          verified: {
            title: 'Save as verified query', submitLabel: 'Save',
            fields: [{ name: 'question', label: 'Question this query answers', required: true, placeholder: 'e.g. Monthly revenue for the last 12 months' }],
            run: (v) => saveVerified(v.question.trim()),
          },
          bookmark: {
            title: 'Bookmark this query', submitLabel: 'Bookmark',
            fields: [{ name: 'name', label: 'Bookmark name', required: true }],
            run: (v) => bookmark(v.name.trim()),
          },
          pin: {
            title: 'Pin to dashboard', submitLabel: 'Pin',
            fields: [
              { name: 'dash', label: 'Dashboard (created if new)', required: true },
              { name: 'title', label: 'Widget title', defaultValue: 'Result', required: true },
            ],
            run: (v) => pin(v.dash.trim(), v.title.trim()),
          },
          schedule: {
            title: 'Schedule this query', submitLabel: 'Create schedule',
            fields: [
              { name: 'name', label: 'Schedule name', defaultValue: 'Scheduled query', required: true },
              { name: 'cron', label: 'Cron (5 fields — e.g. 0 7 * * * = daily 07:00)', defaultValue: '0 7 * * *', required: true, mono: true },
            ],
            run: (v) => schedule(v.name.trim(), v.cron.trim()),
          },
        };
        const active = modal ? cfg[modal] : null;
        return active ? (
          <FormModal open title={active.title} submitLabel={active.submitLabel} fields={active.fields}
            onSubmit={(v) => { setModal(null); active.run(v); }} onClose={() => setModal(null)} />
        ) : null;
      })()}
    </div>
  );
}
