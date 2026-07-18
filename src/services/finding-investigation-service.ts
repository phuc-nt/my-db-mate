/**
 * Investigate-from-finding: turn a monitor/anomaly finding into an agent
 * investigation with a hard, per-session SQL-step cap.
 *
 * Security contract (red-team 2026-07-18):
 * - The client only ever sends an `InvestigationTarget` (validated union). The
 *   finding CONTEXT string is built server-side here — no client text reaches
 *   the system prompt.
 * - Every DB-sourced value is escaped (no literal `</data>` can survive) before
 *   being wrapped in <data>…</data>, so a malicious value cannot close the
 *   wrapper and inject instructions.
 * - The 5-step cap is a per-SESSION persisted counter (chat_sessions.metadata),
 *   reserved atomically — reopening the session or firing parallel turns cannot
 *   reset or race past it.
 */
import { and, eq, lte, sql as dsql } from 'drizzle-orm';
import { db } from '../db/client';
import { chatSessions, schemaTables, schemaColumns } from '../db/schema';
import { scheduledQueries } from '../db/ecosystem-schema';
import { monitorSnapshots } from '../db/monitor-schema';
import { columnProfiles } from '../db/intelligence-schema';
import { median, mad } from '../lib/robust-stats';
import type { MonitorFinding, Snapshot } from '../lib/monitor-diff';

/** Hard ceiling on run_sql calls for a finding investigation. A client-supplied
 *  value can only lower it, never raise it. */
export const INVESTIGATE_FINDING_MAX_SQL = 5;

/** Session-metadata keys (single place, so route/agent/service agree). */
export const META_TARGET_KEY = 'investigationTarget';
export const META_SQL_USED_KEY = 'investigationSqlUsed';

export type InvestigationTarget =
  | {
      kind: 'monitor';
      scheduleId: string;
      /** ISO timestamp of the monitor run that produced the finding — bounds the
       *  baseline fetch so we judge against history AS OF the finding, not a
       *  baseline that has since absorbed the very drift under investigation. */
      runCreatedAt: string;
      finding: Pick<MonitorFinding, 'table' | 'metric' | 'before' | 'after' | 'deltaPct'>;
    }
  | {
      kind: 'anomaly';
      table: string;
      column: string;
      /** Deterministic summary numbers from the Data Health card (numbers only —
       *  strings from the client never enter the prompt unescaped). */
      summary?: { total?: number; nullRate?: number; outlierCount?: number; madOutlierCount?: number };
    };

/** Escape a DB-sourced value so it cannot terminate its <data> wrapper. Strips
 *  any `<data>`/`</data>` token (case-insensitive, whitespace-tolerant). Loops to
 *  a fixed point: a single pass is bypassable by token reconstruction
 *  (e.g. `</da<data>ta>` collapses to `</data>` after one strip). */
export function escapeForDataWrap(v: unknown): string {
  let s = String(v ?? 'null');
  let prev: string;
  do { prev = s; s = s.replace(/<\s*\/?\s*data\s*>/gi, ''); } while (s !== prev);
  return s;
}

function wrap(v: unknown): string {
  return `<data>${escapeForDataWrap(v)}</data>`;
}

/** Parse + validate an untrusted request body into an InvestigationTarget.
 *  Throws with a plain message on any shape/reference violation. */
export async function validateInvestigationTarget(connectionId: string, body: unknown): Promise<InvestigationTarget> {
  const b = body as Record<string, unknown> | null;
  if (!b || typeof b !== 'object') throw new Error('invalid target');
  if (b.kind === 'monitor') {
    const { scheduleId, runCreatedAt, finding } = b as { scheduleId?: unknown; runCreatedAt?: unknown; finding?: Record<string, unknown> };
    if (typeof scheduleId !== 'string' || typeof runCreatedAt !== 'string' || Number.isNaN(Date.parse(runCreatedAt))) throw new Error('invalid monitor target');
    const [sched] = await db.select({ id: scheduledQueries.id }).from(scheduledQueries)
      .where(and(eq(scheduledQueries.id, scheduleId), eq(scheduledQueries.connectionId, connectionId)));
    if (!sched) throw new Error('schedule not found for this connection');
    if (!finding || typeof finding.table !== 'string' || typeof finding.metric !== 'string') throw new Error('invalid finding');
    // Shape-validate the metric: only the three monitor-emitted forms are ever
    // meaningful (metricFromSnapshot understands nothing else), so anything else is
    // dead weight AND an injection surface — reject rather than escape-and-hope.
    if (!/^(rowCount|(nullRate|avg):[A-Za-z0-9_]+)$/.test(finding.metric)) throw new Error('invalid finding metric');
    await assertKnownTable(connectionId, finding.table);
    return {
      kind: 'monitor',
      scheduleId,
      runCreatedAt,
      finding: {
        table: finding.table,
        metric: finding.metric,
        before: Number(finding.before),
        after: Number(finding.after),
        deltaPct: finding.deltaPct == null ? null : Number(finding.deltaPct),
      },
    };
  }
  if (b.kind === 'anomaly') {
    const { table, column, summary } = b as { table?: unknown; column?: unknown; summary?: Record<string, unknown> };
    if (typeof table !== 'string' || typeof column !== 'string') throw new Error('invalid anomaly target');
    const t = await assertKnownTable(connectionId, table);
    const [c] = await db.select({ id: schemaColumns.id }).from(schemaColumns)
      .where(and(eq(schemaColumns.tableId, t.id), eq(schemaColumns.columnName, column)));
    if (!c) throw new Error(`unknown column: ${table}.${column}`);
    const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
    return {
      kind: 'anomaly', table, column,
      summary: summary && typeof summary === 'object'
        ? { total: num(summary.total), nullRate: num(summary.nullRate), outlierCount: num(summary.outlierCount), madOutlierCount: num(summary.madOutlierCount) }
        : undefined,
    };
  }
  throw new Error('invalid target kind');
}

async function assertKnownTable(connectionId: string, table: string) {
  const [t] = await db.select({ id: schemaTables.id, tableName: schemaTables.tableName })
    .from(schemaTables)
    .where(and(eq(schemaTables.connectionId, connectionId), eq(schemaTables.tableName, table)));
  if (!t) throw new Error(`unknown table: ${table}`);
  return t;
}

/** Candidate breakdown dimensions for a table: low-cardinality columns first
 *  (from column profiles when available), else all non-id-looking columns. */
async function candidateDimensions(connectionId: string, table: string): Promise<string[]> {
  const t = await assertKnownTable(connectionId, table).catch(() => null);
  if (!t) return [];
  const cols = await db.select({ name: schemaColumns.columnName, dataType: schemaColumns.dataType, id: schemaColumns.id })
    .from(schemaColumns).where(eq(schemaColumns.tableId, t.id));
  // Profiles are keyed (connectionId, tableName, columnName) — not by column id.
  const profiles = await db.select({ columnName: columnProfiles.columnName, distinctValues: columnProfiles.distinctValues })
    .from(columnProfiles)
    .where(and(eq(columnProfiles.connectionId, connectionId), eq(columnProfiles.tableName, t.tableName)));
  const profiled = new Map(profiles.map((p) => [p.columnName, p.distinctValues]));
  const lowCard = cols.filter((c) => Array.isArray(profiled.get(c.name)) && (profiled.get(c.name) as unknown[]).length <= 30).map((c) => c.name);
  if (lowCard.length) return lowCard.slice(0, 6);
  return cols
    .filter((c) => !/(^id$|_id$|uuid|^pk_)/i.test(c.name) && /char|text|bool|enum|date|int/i.test(c.dataType))
    .map((c) => c.name)
    .slice(0, 6);
}

/** Build the server-side finding-context block injected into the investigate
 *  addendum. Deterministic, zero LLM calls; every DB string escaped + wrapped. */
export async function buildFindingContext(connectionId: string, target: InvestigationTarget): Promise<string> {
  if (target.kind === 'monitor') {
    const f = target.finding;
    const runAt = new Date(target.runCreatedAt);
    // Baseline AS OF the finding, PRIOR to it: the run that produced the finding
    // stores its own (post-drift) snapshot just before it records the run row, so
    // the newest snapshot at-or-before runAt IS the finding capture — drop it, or
    // the baseline absorbs the very drift under investigation (median/MAD shift).
    const rows = await db.select({ metrics: monitorSnapshots.metrics, capturedAt: monitorSnapshots.capturedAt })
      .from(monitorSnapshots)
      .where(and(
        eq(monitorSnapshots.scheduleId, target.scheduleId),
        eq(monitorSnapshots.tableName, f.table),
        lte(monitorSnapshots.capturedAt, runAt),
      ))
      .orderBy(monitorSnapshots.capturedAt);
    const priorRows = rows.slice(0, -1); // drop the finding-run's own snapshot
    const series = priorRows.map((r) => metricFromSnapshot(r.metrics as Snapshot, f.metric)).filter((v): v is number => v != null);
    const baseline = series.length >= 3
      ? `Baseline as of the finding (${series.length} prior snapshots): median ${wrap(round(median(series)))}, MAD ${wrap(round(mad(series)))}, span ${wrap(priorRows[0]?.capturedAt?.toISOString())} → ${wrap(priorRows[priorRows.length - 1]?.capturedAt?.toISOString())}.`
      : 'Baseline unavailable (too few snapshots in retention as of the finding time — investigate using before/after values only).';
    const dims = await candidateDimensions(connectionId, f.table);
    return `## Finding under investigation (monitor drift)
Table ${wrap(f.table)}, metric ${wrap(f.metric)}: ${wrap(f.before)} → ${wrap(f.after)}${f.deltaPct != null ? ` (${wrap(f.deltaPct)}%)` : ''}, detected at ${wrap(target.runCreatedAt)}.
${baseline}
Candidate breakdown dimensions on this table: ${dims.length ? dims.map(wrap).join(', ') : '(none profiled — discover via schema_details)'}.
Your goal: find the ROOT CAUSE of this change (which slice drove it, when exactly it started, whether it correlates with another column), then conclude with evidence.
You have a HARD cap of ${INVESTIGATE_FINDING_MAX_SQL} SQL queries for this whole investigation — spend them on the highest-information queries first: (1) decompose the metric by a candidate dimension, (2) locate when the change happened, (3) inspect the changed slice. Do not spend multiple queries re-measuring the same total.`;
  }
  const s = target.summary;
  const dims = await candidateDimensions(connectionId, target.table);
  return `## Finding under investigation (column anomaly)
Column ${wrap(`${target.table}.${target.column}`)} was flagged by the anomaly check${s ? ` (total ${wrap(s.total)}, null-rate ${wrap(s.nullRate)}, σ-outliers ${wrap(s.outlierCount)}, MAD-outliers ${wrap(s.madOutlierCount)})` : ''}.
Candidate breakdown dimensions on this table: ${dims.length ? dims.map(wrap).join(', ') : '(none profiled — discover via schema_details)'}.
Your goal: characterize the anomalous values (which rows/slices/time range), find the likely cause, then conclude with evidence.`;
}

function metricFromSnapshot(snap: Snapshot, metric: string): number | null {
  if (metric === 'rowCount') return snap.rowCount;
  const [kind, col] = metric.split(':');
  const m = col ? snap.columns[col] : undefined;
  if (!m) return null;
  if (kind === 'nullRate') return m.nullRate;
  if (kind === 'avg') return m.avg;
  return null;
}

const round = (n: number) => Math.round(n * 1000) / 1000;

/** Atomically reserve one SQL step for a finding-investigation session.
 *  Single UPDATE with a WHERE guard so two parallel turns cannot both take the
 *  last slot. Returns whether the step may run and how many are now used. */
export async function reserveInvestigationStep(sessionId: string, cap: number): Promise<{ allowed: boolean; used: number }> {
  const capped = Math.min(cap, INVESTIGATE_FINDING_MAX_SQL);
  const res = await db.execute(dsql`
    UPDATE chat_sessions
    SET metadata = jsonb_set(coalesce(metadata, '{}'::jsonb), ${`{${META_SQL_USED_KEY}}`}::text[],
      (coalesce((metadata->>${META_SQL_USED_KEY})::int, 0) + 1)::text::jsonb)
    WHERE id = ${sessionId}
      AND coalesce((metadata->>${META_SQL_USED_KEY})::int, 0) < ${capped}
    RETURNING (metadata->>${META_SQL_USED_KEY})::int AS used
  `);
  const row = (res as unknown as { rows: { used: number }[] }).rows?.[0];
  if (row) return { allowed: true, used: Number(row.used) };
  const [cur] = await db.select({ metadata: chatSessions.metadata }).from(chatSessions).where(eq(chatSessions.id, sessionId));
  return { allowed: false, used: Number((cur?.metadata as Record<string, unknown> | null)?.[META_SQL_USED_KEY] ?? capped) };
}

/** Release a reserved step (used when the query did NOT run, e.g. needs_confirmation —
 *  consistent with the in-memory budget which only counts executed queries). */
export async function releaseInvestigationStep(sessionId: string): Promise<void> {
  await db.execute(dsql`
    UPDATE chat_sessions
    SET metadata = jsonb_set(coalesce(metadata, '{}'::jsonb), ${`{${META_SQL_USED_KEY}}`}::text[],
      greatest(coalesce((metadata->>${META_SQL_USED_KEY})::int, 0) - 1, 0)::text::jsonb)
    WHERE id = ${sessionId}
  `);
}

/** Human-readable kickoff message for the investigation's first user turn —
 *  deterministic from the target, so the chat page can autostart after a hard
 *  reload without any client-carried text. */
export function kickoffMessage(target: InvestigationTarget): string {
  if (target.kind === 'monitor') {
    const f = target.finding;
    return `Investigate the data-drift finding on ${f.table} (${f.metric}): ${f.before} → ${f.after}${f.deltaPct != null ? ` (${f.deltaPct}%)` : ''}, detected ${new Date(target.runCreatedAt).toLocaleString()}. Find the root cause.`;
  }
  return `Investigate the anomaly flagged on column ${target.table}.${target.column}. Characterize the anomalous values and find the likely cause.`;
}

/** Session title for an investigation (shown in run history / session lists). */
export function investigationTitle(target: InvestigationTarget): string {
  return target.kind === 'monitor'
    ? `Investigate: ${target.finding.table}.${target.finding.metric}`
    : `Investigate: ${target.table}.${target.column}`;
}

/** Read the stored investigation target of a session (null when the session is a
 *  plain chat). Server-side source of truth for the autostart flow. */
export async function getSessionInvestigationTarget(sessionId: string): Promise<InvestigationTarget | null> {
  const [row] = await db.select({ metadata: chatSessions.metadata }).from(chatSessions).where(eq(chatSessions.id, sessionId));
  const t = (row?.metadata as Record<string, unknown> | null)?.[META_TARGET_KEY];
  return (t as InvestigationTarget | undefined) ?? null;
}
