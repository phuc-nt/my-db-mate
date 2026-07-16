/**
 * The single choke point for running SQL against a target DB:
 *   validate (safety-service) → execute (provider, read-only) → audit (query_runs).
 * Every OLTP path (chat, MCP, schedules, etc.) MUST go through here so nothing
 * bypasses safety or audit. For BigQuery specifically, this is also the sole
 * enforcement point for the cost gate (`bigqueryCostConfirmationToken` below) —
 * but it is NOT the only place BigQuery execution can be blocked: Group A
 * services (profiling, anomaly detection, accelerator snapshots, query-history
 * mining) bypass this file entirely via direct `provider.executeReadOnly()`
 * calls and carry their own `assertNotBigQuery()` guard instead
 * (260715-2034-bigquery-connector-cost-safety/phase-06).
 */
import { and, eq } from 'drizzle-orm';
import { db } from '../db/client';
import { queryRuns, schemaTables } from '../db/schema';
import { columnAnnotations } from '../db/context-schema';
import { getConnection } from './connection-service';
import { buildProvider, type ConnectionRow } from './connection-providers/provider-factory';
import { BigQueryConnectionProvider, EstimateFailedError, MaximumBytesBilledExceededError } from './connection-providers/bigquery-provider';
import { validateSql } from './safety/safety-service';
import { assessRisk } from './risk-scoring-service';
import { shouldAccelerate, planAcceleration } from './accelerator/accelerator-service';
import { ensureSnapshot, cacheKeyFor, upsertSnapshotStatus } from './accelerator/snapshot-cache-service';
import { ensureIncrementalSnapshot } from './accelerator/incremental-snapshot-service';
import { getWatermarkConfig } from './accelerator/watermark-config-service';
import { runAcceleratedQuery } from './accelerator/duckdb-executor-service';
import { extractLineage } from '../lib/sql-lineage';
import { BigQueryConfirmationRequiredError, type QueryResult, type Dialect } from './connection-providers/provider-interface';
import { reserve as reserveBudget, reconcile as reconcileBudget, refund as refundBudget } from './bigquery-daily-budget-service';

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
    await logAccelerationFailure(connectionId, plan.tables, finalSql, e);
    return null;
  }
}

/** Plain console logging matches the existing convention elsewhere in this
 *  codebase (connection-service.ts, schedule-service.ts) — a self-host,
 *  single-user tool doesn't need a logging service for this. Also marks each
 *  involved table's snapshot row `status='failed'` so the accelerator UI
 *  surfaces a query-time DuckDB failure, not only an extraction failure.
 *  Cache key must match whichever variant (plain vs watermark-suffixed)
 *  `ensureSnapshot`/`ensureIncrementalSnapshot` actually used for that table
 *  (see the selection at the `shouldAccelerate` call site above), otherwise
 *  this writes a status row under a key nothing else ever reads. */
async function logAccelerationFailure(connectionId: string, tables: string[], sql: string, e: unknown) {
  const msg = e instanceof Error ? e.message : String(e);
  console.warn('[accelerator] DuckDB execution failed, falling back to live driver:', { sql, error: msg });
  await Promise.all(
    tables.map(async (table) => {
      const extractSql = `SELECT * FROM ${table}`;
      const watermarkConfig = await getWatermarkConfig(connectionId, table);
      const keySource = watermarkConfig ? `${extractSql}::watermark::${watermarkConfig.watermarkCol}` : extractSql;
      await upsertSnapshotStatus({
        connectionId,
        cacheKey: cacheKeyFor(keySource),
        sql: extractSql,
        status: 'failed',
        lastError: msg,
      });
    }),
  );
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
  status: 'ok' | 'blocked' | 'error' | 'needs_confirmation' | 'needs_cost_confirmation';
  result?: QueryResult;
  blockedReason?: string;
  errorMessage?: string;
  executedSql?: string;
  /** Present when status='needs_confirmation' (P3 risk tier). */
  risk?: { tier: 'medium' | 'high'; score: number; reason: string };
  /** Present when status='needs_cost_confirmation' — BigQuery-only, dollar-denominated
   *  dry-run estimate (Phase 3). Distinct from `risk`: this is real-money cost, not a
   *  row-count/performance guess, and gates on its own confirm step. */
  costEstimate?: { estimatedBytes: number; estimatedCostUsd: number; reliable: boolean };
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
  /** BigQuery-only: proof the caller already ran the dry-run estimate + got
   *  explicit user confirmation of the real-money cost (Phase 3/4 flow in
   *  `execute/route.ts`). Deliberately separate from `confirmed`/`skipRiskGate`
   *  — those gate OLTP row-count/performance risk tiers, and a caller setting
   *  them for an OLTP reason must never also skip the BigQuery cost gate.
   *  Callers with no way to obtain one (MCP, scheduled jobs, dashboards, etc.)
   *  get a clean `BigQueryConfirmationRequiredError` instead of executing. */
  bigqueryCostConfirmationToken?: boolean;
  /** BigQuery-only: set ONLY by an interactive caller (`execute/route.ts`) that
   *  can show the returned `needs_cost_confirmation` estimate to a human and
   *  re-call with `bigqueryCostConfirmationToken: true` once approved. Every
   *  other caller (MCP, scheduled jobs, dashboards, notebooks, etc.) has no
   *  human to show an estimate to, so omitting this turns the same "no token
   *  yet" state into an immediate `BigQueryConfirmationRequiredError` instead
   *  of a silently-unactionable `needs_cost_confirmation` response. */
  allowCostEstimatePreview?: boolean;
  /** BigQuery-only: set by background analytics entry points (dashboard/metric/report
   *  refresh) that have NO human to confirm a cost, but SHOULD run unattended within
   *  the connection's daily byte budget. Deliberately separate from
   *  `bigqueryCostConfirmationToken`/`allowCostEstimatePreview`/`confirmed`/`skipRiskGate`
   *  — an OLTP-motivated flag can never reach this path, and this path can never be
   *  reached without an explicit background caller opting in. On a BigQuery connection:
   *  dry-run estimate → reserve against the daily budget → run (or block) → reconcile. */
  backgroundBudgeted?: boolean;
  /** BigQuery-only: set by the DuckDB-over-BigQuery extract service to prevent
   *  infinite recursion when fetching rows for a snapshot extract. When true,
   *  skips the offline-mode check even if `bigqueryOfflineMode` is set on the
   *  connection. Callers MUST NOT set this directly. */
  _bypassOfflineMode?: boolean;
}): Promise<ExecuteResult> {
  const {
    connectionId, sql, sessionId, actor = 'owner', confirmed = false, skipRiskGate = false,
    bigqueryCostConfirmationToken = false, allowCostEstimatePreview = false,
    backgroundBudgeted = false, _bypassOfflineMode = false,
  } = params;
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
    // BigQuery cost gate (Phase 3): dollar-denominated dry-run estimate, entirely
    // separate from assessRisk()'s row-based needs_confirmation flow — BigQuery's
    // explainQuery() always throws, so routing it through assessRisk() would only
    // ever produce a generic "could not estimate" escalation, never a real cost
    // figure. Fail closed: no execution proceeds when the estimate can't be obtained.
    if (provider instanceof BigQueryConnectionProvider) {
      // Per-query hard cap (schema notNull+default → always present). Doubles as the
      // pessimistic sentinel when a successful run's real billed figure is unreadable.
      const bqCap = (conn as unknown as { bigqueryMaxBytesPerQuery?: number }).bigqueryMaxBytesPerQuery ?? 0;

      /** Run the real BigQuery job + audit its billed bytes. Shared by the interactive
       *  confirm-token path and the background-budget path. `onBilled` lets the budget
       *  path reconcile the reservation with the real billed figure. Fail-open guard
       *  (Red Team #3): a successful run with an unreadable billed figure records the
       *  per-query cap sentinel, never null/0, so the daily tally can't undercount. */
      const runBigQueryReal = async (
        onBilled?: (billed: number) => Promise<void>,
      ): Promise<ExecuteResult> => {
        let result: QueryResult;
        try {
          result = await provider.executeReadOnly(finalSql);
        } catch (e) {
          if (e instanceof MaximumBytesBilledExceededError) {
            await audit({ connectionId, sessionId, actor, sql: finalSql, status: 'blocked', blockedReason: e.message });
            return { status: 'blocked', blockedReason: e.message };
          }
          throw e;
        }
        const billed = result.bytesBilled ?? bqCap;
        if (onBilled) await onBilled(billed);
        await audit({
          connectionId, sessionId, actor, sql: finalSql, status: 'ok',
          rowCount: result.rowCount, durationMs: Date.now() - started, bytesBilled: billed,
        });
        return { status: 'ok', result, executedSql: finalSql, lineage: extractLineage(finalSql, conn.dialect) };
      };

      // Path 1 — interactive confirm token: the human already approved the cost.
      if (bigqueryCostConfirmationToken) {
        return await runBigQueryReal();
      }

      // Path 2 — background budgeted (dashboards/metrics/reports, no human present):
      // dry-run estimate → reserve against the daily budget → run → reconcile/refund.
      // Deliberately unreachable via the OLTP confirmed/skipRiskGate flags.
      if (backgroundBudgeted) {
        // Offline mode (Mode 2): serve from a DuckDB-over-BigQuery snapshot instead of
        // querying BigQuery live. The extract itself still goes through THIS budget path
        // (the extract service calls executeQuery with backgroundBudgeted), so there is
        // no un-budgeted BigQuery job. Dynamic import avoids a circular dependency
        // (the extract service imports executeQuery). Cache-valid reads cost $0.
        // _bypassOfflineMode prevents infinite recursion when the extract service's
        // fetchRows callback calls executeQuery internally.
        const offlineMode = !_bypassOfflineMode && (conn as unknown as { bigqueryOfflineMode?: boolean }).bigqueryOfflineMode === true;
        if (offlineMode) {
          const { extractBigQueryToDuckDB, BigQueryExtractBlockedError } = await import('./accelerator/bigquery-duckdb-extract-service');
          try {
            const { result, asOf } = await extractBigQueryToDuckDB(connectionId, finalSql);
            return {
              status: 'ok',
              result: { ...result, accelerated: { asOf: asOf.toISOString() } },
              executedSql: finalSql,
              lineage: extractLineage(finalSql, conn.dialect),
            };
          } catch (e) {
            // A blocked extract (budget/cap refused the job) is a clean blocked status,
            // typed via BigQueryExtractBlockedError — not regex-matched on the message.
            if (e instanceof BigQueryExtractBlockedError) {
              return { status: 'blocked', blockedReason: e.message, executedSql: finalSql };
            }
            return { status: 'error', errorMessage: e instanceof Error ? e.message : String(e), executedSql: finalSql };
          }
        }
        let estimate;
        try {
          estimate = await provider.estimateCost(finalSql);
        } catch (e) {
          const msg = e instanceof EstimateFailedError ? e.message : (e instanceof Error ? e.message : String(e));
          await audit({ connectionId, sessionId, actor, sql: finalSql, status: 'blocked', blockedReason: `cost estimate failed: ${msg}` });
          return { status: 'error', errorMessage: `Could not estimate cost — query not run: ${msg}`, executedSql: finalSql };
        }
        const budget = (conn as unknown as { bigqueryDailyBytesBudget?: number }).bigqueryDailyBytesBudget ?? 0;
        const now = new Date();
        const admitted = await reserveBudget(connectionId, budget, estimate.estimatedBytes, now);
        if (!admitted) {
          const reason = `daily byte budget exceeded: this query's estimate (${estimate.estimatedBytes} bytes) plus today's usage would exceed the ${budget}-byte daily budget`;
          await audit({ connectionId, sessionId, actor, sql: finalSql, status: 'blocked', blockedReason: reason });
          return { status: 'blocked', blockedReason: reason };
        }
        // The reservation is released exactly once: reconcile (moves estimate→committed
        // with real billed) OR refund (releases estimate, commits nothing) — never both.
        // `settled` guards against a double-release if audit() throws AFTER reconcile ran
        // on the ok path, which would otherwise let refund free budget headroom that
        // belongs to other concurrent queries (the GREATEST(...,0) clamp would hide it).
        let settled = false;
        try {
          const res = await runBigQueryReal(async (billed) => {
            await reconcileBudget(connectionId, estimate.estimatedBytes, billed, now);
            settled = true;
          });
          if (!settled) await refundBudget(connectionId, estimate.estimatedBytes, now);
          return res;
        } catch (e) {
          if (!settled) await refundBudget(connectionId, estimate.estimatedBytes, now);
          throw e;
        }
      }

      // Path 3 — interactive preview (a human is present to see the estimate).
      if (allowCostEstimatePreview) {
        let estimate;
        try {
          estimate = await provider.estimateCost(finalSql);
        } catch (e) {
          const msg = e instanceof EstimateFailedError ? e.message : (e instanceof Error ? e.message : String(e));
          await audit({ connectionId, sessionId, actor, sql: finalSql, status: 'blocked', blockedReason: `cost estimate failed: ${msg}` });
          return { status: 'error', errorMessage: `Could not estimate cost — query not run: ${msg}`, executedSql: finalSql };
        }
        return { status: 'needs_cost_confirmation', executedSql: finalSql, costEstimate: estimate };
      }

      // Path 4 — no token, no budget opt-in, no preview: fail closed.
      throw new BigQueryConfirmationRequiredError();
    }

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
  /** BigQuery-only real billed bytes for the daily-budget tally (or the per-query
   *  cap sentinel when a successful run's figure was unreadable). Null for non-BQ. */
  bytesBilled?: number | null;
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
    bytesBilled: row.bytesBilled ?? null,
  });
}
