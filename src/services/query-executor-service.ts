/**
 * The single choke point for running SQL against a target DB:
 *   validate (safety-service) → execute (provider, read-only) → audit (query_runs).
 * Every path (chat, MCP later) MUST go through here so nothing bypasses safety
 * or audit. `actor` is threaded from P1 (default 'owner') for P4 identity (RT-F6).
 */
import { and, eq } from 'drizzle-orm';
import { db } from '../db/client';
import { queryRuns, schemaTables } from '../db/schema';
import { columnAnnotations } from '../db/context-schema';
import { getConnection } from './connection-service';
import { buildProvider, type ConnectionRow } from './connection-providers/provider-factory';
import { validateSql } from './safety/safety-service';
import { assessRisk } from './risk-scoring-service';
import { shouldAccelerate, planAcceleration } from './accelerator-service';
import { ensureSnapshot } from './snapshot-cache-service';
import { ensureIncrementalSnapshot } from './incremental-snapshot-service';
import { getWatermarkConfig } from './watermark-config-service';
import { runAcceleratedQuery } from './duckdb-executor-service';
import { extractLineage } from '../lib/sql-lineage';
import type { QueryResult, Dialect } from './connection-providers/provider-interface';

// Fallback snapshot TTL when a connection has the accelerator enabled but no
// explicit `accelerateTtlMs` set — 1 hour balances staleness against re-extract
// cost for a self-host, single-user tool.
const DEFAULT_ACCELERATE_TTL_MS = 60 * 60 * 1000;

// A JOIN's per-table snapshots can each have their own TTL-driven `asOf`. When
// the spread between the earliest and latest snapshot exceeds this fraction of
// the TTL, the badge should surface the skew instead of showing one clean
// "as of {earliest}" timestamp that hides how far apart the tables actually are.
const SKEW_THRESHOLD_FRACTION = 0.5;

/** Extracts one table's Parquet snapshot and runs the original SQL against
 *  DuckDB views over those snapshots. Returns null (never throws) when the SQL
 *  can't be safely accelerated or the DuckDB path itself fails — callers must
 *  fall back to `provider.executeReadOnly()`, since it is always safer to
 *  serve a live, unaccelerated result than to risk a wrong accelerated one. */
async function tryAccelerate(
  connectionId: string,
  provider: import('./connection-providers/provider-interface').ConnectionProvider,
  finalSql: string,
  dialect: Dialect,
  ttlMs: number,
): Promise<QueryResult | null> {
  const plan = planAcceleration(finalSql, dialect);
  if ('error' in plan) return null;

  try {
    const snapshots = await Promise.all(
      plan.tables.map(async (table) => {
        const watermarkConfig = await getWatermarkConfig(connectionId, table);
        const snapshot = watermarkConfig
          ? await ensureIncrementalSnapshot(connectionId, provider, `SELECT * FROM ${table}`, watermarkConfig.watermarkCol, ttlMs)
          : await ensureSnapshot(connectionId, provider, `SELECT * FROM ${table}`, ttlMs);
        return { table, snapshot };
      }),
    );
    const tableToSnapshot = new Map(snapshots.map(({ table, snapshot }) => [table, snapshot.path]));
    const asOfTimes = snapshots.map(({ snapshot }) => snapshot.asOf.getTime());
    const earliestAsOf = new Date(Math.min(...asOfTimes));
    const spreadMs = Math.max(...asOfTimes) - Math.min(...asOfTimes);
    const skewWarning = plan.tables.length > 1 && spreadMs > ttlMs * SKEW_THRESHOLD_FRACTION
      ? { spreadMs }
      : undefined;

    const result = await runAcceleratedQuery(finalSql, tableToSnapshot);
    return { ...result, accelerated: { asOf: earliestAsOf.toISOString(), skewWarning } };
  } catch (e) {
    // DuckDB execution failed (e.g. a construct planAcceleration's whitelist
    // missed) — fall back rather than surface an accelerator-specific error,
    // but log it distinctly from the "not eligible" early-return above so a
    // real whitelist gap doesn't fail silently with zero signal.
    logAccelerationFailure(finalSql, e);
    return null;
  }
}

/** Plain console logging matches the existing convention elsewhere in this
 *  codebase (connection-service.ts, schedule-service.ts) — a self-host,
 *  single-user tool doesn't need a logging service for this. */
function logAccelerationFailure(sql: string, e: unknown) {
  const msg = e instanceof Error ? e.message : String(e);
  console.warn('[accelerator] DuckDB execution failed, falling back to live driver:', { sql, error: msg });
}

/** Largest synced rowCount among tables whose name appears in the SQL (red-team
 *  C3). Lets the risk scorer escalate a SQLite full scan on a big table, where
 *  EXPLAIN gives no row estimate so a 10M-row scan would otherwise score LOW. */
async function maxReferencedTableRows(connectionId: string, sql: string): Promise<number | null> {
  const tables = await db.select({ tableName: schemaTables.tableName, rowCount: schemaTables.rowCount })
    .from(schemaTables)
    .where(eq(schemaTables.connectionId, connectionId));
  const lower = sql.toLowerCase();
  let max: number | null = null;
  for (const t of tables) {
    if (t.rowCount == null) continue;
    const name = t.tableName.toLowerCase().replace(/[^a-z0-9_]/g, '');
    if (name && new RegExp(`\\b${name}\\b`).test(lower)) {
      if (max == null || t.rowCount > max) max = t.rowCount;
    }
  }
  return max;
}

/** True if the SQL text references any column flagged sensitive for this connection.
 *  Exported so pin/report paths can block sharing a query over sensitive data (C4). */
export async function touchesSensitiveColumns(connectionId: string, sql: string): Promise<boolean> {
  const sensitive = await db.select({ columnName: columnAnnotations.columnName })
    .from(columnAnnotations)
    .where(and(eq(columnAnnotations.connectionId, connectionId), eq(columnAnnotations.isSensitive, true)));
  if (sensitive.length === 0) return false;
  const lower = sql.toLowerCase();
  return sensitive.some((c) => new RegExp(`\\b${c.columnName.toLowerCase().replace(/[^a-z0-9_]/g, '')}\\b`).test(lower));
}

/** True if the connection has ANY column flagged sensitive. Used to reject `SELECT *`
 *  on a share surface (review M1): `*` never names the column, so a name-match can't
 *  catch it — when sensitive columns exist, a wildcard select is treated as risky. */
export async function connectionHasSensitiveColumns(connectionId: string): Promise<boolean> {
  const rows = await db.select({ id: columnAnnotations.id })
    .from(columnAnnotations)
    .where(and(eq(columnAnnotations.connectionId, connectionId), eq(columnAnnotations.isSensitive, true)))
    .limit(1);
  return rows.length > 0;
}

export interface ExecuteResult {
  status: 'ok' | 'blocked' | 'error' | 'needs_confirmation';
  result?: QueryResult;
  blockedReason?: string;
  errorMessage?: string;
  executedSql?: string;
  /** Present when status='needs_confirmation' (P3 risk tier). */
  risk?: { tier: 'medium' | 'high'; score: number; reason: string };
  /** AST-derived read lineage (tables/filters/grouping) — null when unparsable. */
  lineage?: import('../lib/sql-lineage').SqlLineage | null;
}

export async function executeQuery(params: {
  connectionId: string;
  sql: string;
  sessionId?: string;
  actor?: string;
  /** Skip the risk gate — caller already confirmed a medium-risk query. High risk
   *  is never runnable this way; it must go through P4 approval. */
  confirmed?: boolean;
  /** Skip the risk EXPLAIN for two safe classes: (a) app-generated, known-cheap
   *  queries (e.g. the sample_rows tool's `... LIMIT 5`) to avoid a per-query
   *  EXPLAIN round-trip on the hot path (code-review M2); (b) app-validated
   *  STORED SQL that already passed the full gate at save time and is immutable
   *  without re-validation (metrics, monitors). Never set from user/agent
   *  FREE-FORM SQL — validateSql still applies either way. */
  skipRiskGate?: boolean;
}): Promise<ExecuteResult> {
  const { connectionId, sql, sessionId, actor = 'owner', confirmed = false, skipRiskGate = false } = params;
  const conn = await getConnection(connectionId);
  if (!conn) return { status: 'error', errorMessage: 'Connection not found' };

  const verdict = validateSql(sql, conn.dialect as Dialect);

  // Blocked by safety → audit and return without touching the DB.
  if (verdict.status === 'blocked') {
    await audit({ connectionId, sessionId, actor, sql, status: 'blocked', blockedReason: verdict.reason });
    return { status: 'blocked', blockedReason: verdict.reason };
  }

  // Consult the read-only verification (RT-F2). The SELECT-only DB grant is the
  // real boundary; when the probe found a writable user, the app-layer guards
  // (safety-service + read-only txn) are all that remain, so any execution on
  // such a connection is recorded distinctly for the audit trail rather than
  // silently treated as safe. (Not hard-blocked: SQLite readonly handles and
  // properly-granted users are the common dogfood case.)
  const onWritableConn = conn.isReadOnlyVerified === false;
  const finalSql = verdict.sql;

  const provider = buildProvider(conn as unknown as ConnectionRow);
  const started = Date.now();
  try {
    // Risk gate (P3): estimate blast radius and require confirmation for medium,
    // block high. Performance guard only — not a security control. Skipped for
    // app-generated bounded queries to avoid a per-query EXPLAIN (M2).
    let risk: Awaited<ReturnType<typeof assessRisk>> | undefined;
    if (!skipRiskGate) {
    const sensitive = await touchesSensitiveColumns(connectionId, finalSql);
    const maxTableRows = await maxReferencedTableRows(connectionId, finalSql);
    risk = await assessRisk(provider, finalSql, { sensitiveColumnsTouched: sensitive, maxTableRows });
    if (risk.tier === 'high') {
      await audit({ connectionId, sessionId, actor, sql: finalSql, status: 'blocked', blockedReason: `high risk: ${risk.reason}` });
      return { status: 'blocked', blockedReason: `High-risk query blocked: ${risk.reason}. (Approval workflow arrives in P4.)` };
    }
    if (risk.tier === 'medium' && !confirmed) {
      return { status: 'needs_confirmation', executedSql: finalSql, risk: { tier: 'medium', score: risk.score, reason: risk.reason } };
    }
    }

    // Accelerator (Phase 2): only ever considered when the risk gate actually
    // ran (skipRiskGate=false) and the connection opted in AND the query is
    // expensive enough to be worth it. `tryAccelerate` itself falls back to
    // null (never throws) for anything it can't safely handle, so the
    // `?? await provider.executeReadOnly(...)` below is the single fallback
    // path — same result shape either way.
    const connRow = conn as unknown as { accelerateEnabled?: boolean; accelerateTtlMs?: number | null };
    const result =
      (risk && shouldAccelerate({ accelerateEnabled: connRow.accelerateEnabled === true }, risk)
        ? await tryAccelerate(connectionId, provider, finalSql, conn.dialect as Dialect, connRow.accelerateTtlMs ?? DEFAULT_ACCELERATE_TTL_MS)
        : null) ?? (await provider.executeReadOnly(finalSql));
    await audit({
      connectionId,
      sessionId,
      actor,
      sql: finalSql,
      status: 'ok',
      rowCount: result.rowCount,
      durationMs: Date.now() - started,
      blockedReason: onWritableConn ? 'executed on a NON-read-only connection (DB user can write)' : undefined,
    });
    return { status: 'ok', result, executedSql: finalSql, lineage: extractLineage(finalSql, conn.dialect) };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await audit({
      connectionId,
      sessionId,
      actor,
      sql: finalSql,
      status: 'error',
      blockedReason: msg,
      durationMs: Date.now() - started,
    });
    return { status: 'error', errorMessage: msg, executedSql: finalSql };
  } finally {
    await provider.close();
  }
}

async function audit(row: {
  connectionId: string;
  sessionId?: string;
  actor: string;
  sql: string;
  status: string;
  blockedReason?: string;
  rowCount?: number;
  durationMs?: number;
}) {
  await db.insert(queryRuns).values({
    connectionId: row.connectionId,
    sessionId: row.sessionId ?? null,
    actor: row.actor,
    sql: row.sql,
    status: row.status,
    blockedReason: row.blockedReason ?? null,
    rowCount: row.rowCount ?? null,
    durationMs: row.durationMs ?? null,
  });
}
