'use client';

import { useEffect, useRef, useState } from 'react';
import { CopyButton } from './copy-button';
import { FormModal, type FormModalField } from './form-modal';
import { ResultTable } from './result-table';
import { shouldAutoChart } from '../services/chart-spec-service';
import { guessGrain } from '../lib/metric-math';
import type { ExportDialect } from '../lib/export-formats';

interface RunResult {
  columns: string[];
  rows: unknown[][];
  executedSql?: string;
  lineage?: { tables: string[]; whereColumns: string[]; groupBy: string[] } | null;
  /** Present when served from the DuckDB accelerator's Parquet snapshot cache
   *  instead of the live driver — `asOf` is the snapshot's extraction time (ISO). */
  accelerated?: { asOf: string };
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
  question,
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
  /** User question that produced this query — teach-flow + save-verified prefill. */
  question?: string;
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
  const [modal, setModal] = useState<null | 'verified' | 'bookmark' | 'pin' | 'schedule' | 'metric'>(null);
  // Per-connection SQL visibility default (localStorage — deliberately NOT in
  // connections.config: the edit form rebuilds config from an allowlist and
  // would silently drop extra keys). 'expanded' keeps today's behavior.
  const [sqlShown, setSqlShown] = useState(true);
  // Teach flow (thumbs-down): log why the answer was wrong, let the user fix the
  // SQL and rerun, then offer saving the fix as a verified query (the correction
  // becomes future few-shot material — the whole point of the loop).
  const [teachOpen, setTeachOpen] = useState(false);
  // Ref (not state): submitTeach sets it then immediately reruns — state would
  // still be stale inside that same rerun call.
  const feedbackIdRef = useRef<string | null>(null);
  const [teachFixReady, setTeachFixReady] = useState(false);
  const [teachSaveOpen, setTeachSaveOpen] = useState(false);
  // Multi-candidate (confirm path only): one alternative formulation + its risk.
  const [alternative, setAlternative] = useState<{ sql: string; risk: { tier: string; reason: string } } | null>(null);
  const [chosenSql, setChosenSql] = useState<'original' | 'alternative'>('original');
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

  async function rerun(confirmed = false, sqlOverride?: string) {
    const runSql = sqlOverride ?? sql;
    if (sqlOverride) setSql(sqlOverride);
    setBusy(true);
    setBlocked(undefined);
    setError(undefined);
    setSaveMsg('');
    setConfirmRisk(undefined);
    try {
      const res = await fetch(`/api/connections/${connectionId}/execute`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sql: runSql, sessionId, confirmed }),
      });
      const data = await res.json();
      if (data.status === 'blocked') { setBlocked(data.reason); setResult(undefined); }
      else if (data.status === 'needs_confirmation') {
        setConfirmRisk(data.risk);
        setResult(undefined);
        setAlternative(null);
        setChosenSql('original');
        // Confirm path only: offer ONE differently-formulated candidate with its
        // own risk so the user can pick. Silent fallback on null.
        fetch(`/api/connections/${connectionId}/alternative-sql`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sql: runSql, question, riskReason: data.risk?.reason }),
        }).then((r) => r.json()).then((d) => setAlternative(d.alternative ?? null)).catch(() => {});
      }
      else if (data.status === 'error') { setError(data.error); setResult(undefined); }
      else {
        setResult({ columns: data.columns, rows: data.rows, executedSql: data.executedSql, lineage: data.lineage, accelerated: data.accelerated });
        setLastExecutedSql(data.executedSql);
        if (feedbackIdRef.current) setTeachFixReady(true);
        if (confirmed) onConfirmedRun?.({ sql: data.executedSql ?? runSql, columns: data.columns, rows: data.rows });
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

  /** Save the executed (time, value) query as a tracked metric. Server re-runs
   *  and shape-validates it, so a mis-shaped query fails with a clear message. */
  async function trackAsMetric(v: Record<string, string>) {
    if (!lastExecutedSql) return;
    const r = await fetch(`/api/connections/${connectionId}/metrics`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: v.name.trim(), sql: lastExecutedSql, timeGrain: v.timeGrain, direction: v.direction, target: v.target || undefined,
        dimensions: (v.dimensions ?? '').split(',').map((d) => d.trim()).filter(Boolean) || undefined,
      }),
    });
    const d = await r.json().catch(() => ({}));
    setSaveMsg(r.ok ? `Tracking "${v.name.trim()}" ✓ — see the Metrics tab` : `metric failed: ${d.error ?? 'error'}`);
  }

  async function submitTeach(v: Record<string, string>) {
    // Log the feedback row first (even if the fixed SQL later fails to run).
    const r = await fetch(`/api/connections/${connectionId}/feedback`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ question: question ?? '(unknown)', sql, reason: v.reason, note: v.note, sessionId }),
    });
    const d = await r.json().catch(() => ({}));
    if (d.id) feedbackIdRef.current = d.id;
    setTeachFixReady(false);
    if (v.sql.trim() && v.sql.trim() !== sql.trim()) await rerun(false, v.sql.trim());
  }

  /** Save the teach-flow fix as a verified query and link it to the feedback row. */
  async function saveTeachFix(q: string) {
    if (!lastExecutedSql) return;
    const r = await fetch(`/api/connections/${connectionId}/context`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'verified_query', question: q, sql: lastExecutedSql }),
    });
    const d = await r.json().catch(() => ({}));
    if (r.ok && d.id && feedbackIdRef.current) {
      await fetch(`/api/connections/${connectionId}/feedback`, {
        method: 'PATCH', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ feedbackId: feedbackIdRef.current, fixedVerifiedQueryId: d.id }),
      });
    }
    setTeachFixReady(false);
    feedbackIdRef.current = null;
    setSaveMsg(r.ok ? 'Fix saved as verified query ✓' : 'save failed');
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
            {shouldAutoChart(result.columns, result.rows)?.type === 'line' && (
              <button onClick={() => setModal('metric')} data-testid="track-as-metric"
                className="rounded border px-3 py-1 hover:bg-neutral-100 dark:hover:bg-neutral-800">📈 Track as metric</button>
            )}
          </>
        )}
        <button onClick={() => setTeachOpen(true)} data-testid="teach-flow-open"
          className="rounded border px-2 py-1 text-neutral-500 hover:bg-neutral-100 dark:hover:bg-neutral-800" title="Sai rồi — sửa và dạy lại">👎</button>
        {saveMsg && <span className="text-green-600">{saveMsg}</span>}
      </div>
      {teachFixReady && (
        <div className="mt-1 rounded border border-green-300 bg-green-50 p-2 text-green-800 dark:bg-green-950/30 dark:text-green-400" data-testid="teach-fix-cta">
          Fix ran OK.{' '}
          <button onClick={() => { setModal(null); setTeachSaveOpen(true); }} className="underline">Save fix as verified query</button>
        </div>
      )}
      {confirmRisk && (
        <div className="mt-1 rounded border border-amber-300 bg-amber-50 p-2 text-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
          <div>⚠ {confirmRisk.tier}-risk query: {confirmRisk.reason}</div>
          {alternative && (
            <div className="mt-1 space-y-1" data-testid="candidate-picker">
              <label className="flex items-start gap-1">
                <input type="radio" name="cand" checked={chosenSql === 'original'} onChange={() => setChosenSql('original')} />
                <span><b>Original</b> ({confirmRisk.tier}: {confirmRisk.reason})<pre className="mt-0.5 overflow-x-auto whitespace-pre-wrap font-mono text-[10px] opacity-80">{sql}</pre></span>
              </label>
              <label className="flex items-start gap-1">
                <input type="radio" name="cand" checked={chosenSql === 'alternative'} onChange={() => setChosenSql('alternative')} />
                <span><b>Alternative</b> ({alternative.risk.tier}: {alternative.risk.reason})<pre className="mt-0.5 overflow-x-auto whitespace-pre-wrap font-mono text-[10px] opacity-80">{alternative.sql}</pre></span>
              </label>
            </div>
          )}
          <button onClick={() => { setAlternative(null); rerun(true, chosenSql === 'alternative' && alternative ? alternative.sql : undefined); }}
            disabled={busy} className="mt-1 rounded bg-amber-600 px-3 py-1 text-white">Confirm & run {alternative ? 'selected' : 'anyway'}</button>
        </div>
      )}
      {blocked && <p className="mt-1 text-amber-600">Blocked: {blocked}</p>}
      {error && <p className="mt-1 text-red-600">Error: {error}</p>}
      {result?.accelerated && (
        <p className="mt-1 text-[11px] text-neutral-400" data-testid="accelerated-badge" title="Served from a cached DuckDB/Parquet snapshot instead of the live database">
          ⚡ Accelerated · snapshot as of {new Date(result.accelerated.asOf).toLocaleString()}
        </p>
      )}
      {result?.lineage && result.lineage.tables.length > 0 && (
        <p className="mt-1 text-[11px] text-neutral-400" data-testid="lineage-line">
          from {result.lineage.tables.join(', ')}
          {result.lineage.whereColumns.length > 0 && <> · filtered by {result.lineage.whereColumns.join(', ')}</>}
          {result.lineage.groupBy.length > 0 && <> · grouped by {result.lineage.groupBy.join(', ')}</>}
        </p>
      )}
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
              { name: 'title', label: 'Widget title — tip: use {{from}} and {{to}} in the SQL to make the widget follow the dashboard date range', defaultValue: 'Result', required: true },
            ],
            run: (v) => pin(v.dash.trim(), v.title.trim()),
          },
          metric: {
            title: 'Track as metric', submitLabel: 'Track',
            fields: [
              { name: 'name', label: 'Metric name', defaultValue: question ?? '', required: true },
              { name: 'timeGrain', label: 'Time grain (guessed from the result)', type: 'select',
                defaultValue: result ? guessGrain(result.rows) : 'month', options: [
                  { value: 'day', label: 'Day' }, { value: 'week', label: 'Week' }, { value: 'month', label: 'Month' },
                ] },
              { name: 'direction', label: 'Good direction', type: 'select', defaultValue: 'up_good', options: [
                { value: 'up_good', label: '▲ Up is good' }, { value: 'down_good', label: '▼ Down is good' }, { value: 'neutral', label: 'Neutral' },
              ] },
              { name: 'target', label: 'Target (optional)' },
              { name: 'dimensions', label: 'Dimensions (optional, ≤3 columns comma-separated — digest reports top drivers)' },
            ],
            run: (v) => trackAsMetric(v),
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
      {teachOpen && (
        <FormModal open title="Sai rồi — dạy lại" submitLabel="Sửa & chạy lại"
          fields={[
            { name: 'reason', label: 'Sai chỗ nào?', type: 'select', options: [
              { value: 'wrong-data', label: 'Sai data / sai số' },
              { value: 'missing-context', label: 'Thiếu ngữ cảnh nghiệp vụ' },
              { value: 'misunderstood', label: 'Hiểu sai câu hỏi' },
              { value: 'other', label: 'Khác' },
            ] },
            { name: 'note', label: 'Ghi chú (tuỳ chọn)' },
            { name: 'sql', label: 'SQL (sửa trực tiếp rồi chạy lại)', type: 'textarea', mono: true, defaultValue: sql, required: true },
          ]}
          onSubmit={(v) => { setTeachOpen(false); submitTeach(v); }} onClose={() => setTeachOpen(false)} />
      )}
      {teachSaveOpen && (
        <FormModal open title="Save fix as verified query" submitLabel="Save"
          fields={[{ name: 'question', label: 'Question this query answers', defaultValue: question ?? '', required: true }]}
          onSubmit={(v) => { setTeachSaveOpen(false); saveTeachFix(v.question.trim()); }} onClose={() => setTeachSaveOpen(false)} />
      )}
    </div>
  );
}
