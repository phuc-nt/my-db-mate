/**
 * Snapshot cache (DuckDB accelerator foundation, P1) — extract-once-per-TTL.
 * Runs an "extract" SQL through the connection's OWN `provider.executeReadOnly()`
 * (no bypass of the safety gate, no separate connection), writes the rows to a
 * local Parquet file via DuckDB's own node binding, and reuses that file for
 * repeat calls within the TTL window instead of re-querying the source DB.
 *
 * This is the shared foundation for both the DuckDB accelerator (query routing,
 * a later phase) and any future Parquet-export feature — one cache mechanism,
 * multiple consumers. Incremental (watermark-based) refresh lives in
 * `incremental-snapshot-service.ts`, which reuses the row-typing/insert
 * helpers exported here.
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DuckDBInstance, BIGINT, DOUBLE, BOOLEAN, VARCHAR, type DuckDBType, type DuckDBValue } from '@duckdb/node-api';
import { db } from '../../db/client';
import { accelerateSnapshots } from '../../db/schema';
import type { ConnectionProvider } from '../connection-providers/provider-interface';

export const CACHE_ROOT = path.join(process.cwd(), '.cache', 'snapshots');

// Threshold-triggered compression (Phase 3): row count is known before the
// COPY TO write (no double-write needed to measure real file size first), so
// it's the primary trigger — see phase-03-partitioning-compression-threshold.md.
// Snapshots at/under the threshold keep today's default COPY options unchanged.
const ROW_COUNT_COMPRESSION_THRESHOLD = 1_000_000;
const ROW_GROUP_SIZE = 500_000;

export interface SnapshotMeta {
  asOf: string; // ISO timestamp
  // Present only for incremental snapshots (Phase 2). `watermarkCol` names the
  // column the delta extract filters on; `lastWatermark` is its highest seen
  // value (as text — the source column may be TIMESTAMP or numeric).
  watermarkCol?: string;
  lastWatermark?: string;
}

export interface SnapshotResult {
  path: string;
  asOf: Date;
}

// In-memory lock so two near-simultaneous calls for the same cache key don't
// both extract — self-host single-process single-user, no distributed lock needed.
export const inFlight = new Map<string, Promise<SnapshotResult>>();

export function cacheKeyFor(extractSql: string): string {
  return createHash('sha256').update(extractSql).digest('hex').slice(0, 16);
}

export function cachePaths(connectionId: string, cacheKey: string) {
  const dir = path.join(CACHE_ROOT, connectionId);
  return {
    dir,
    parquetPath: path.join(dir, `${cacheKey}.parquet`),
    metaPath: path.join(dir, `${cacheKey}.meta.json`),
  };
}

export async function readMeta(metaPath: string): Promise<SnapshotMeta | null> {
  try {
    const raw = await readFile(metaPath, 'utf-8');
    return JSON.parse(raw) as SnapshotMeta;
  } catch {
    return null;
  }
}

/** A column's inferred DuckDB SQL type (for CREATE TABLE) plus the matching
 *  DuckDB param type/cast for the INSERT bind. TIMESTAMP columns bind as
 *  VARCHAR (ISO string) with a SQL-side `::TIMESTAMP` cast — the node
 *  binding's typed timestamp params require a wrapper value class, whereas
 *  binding VARCHAR + casting in SQL round-trips a plain JS `Date` losslessly. */
export interface ColumnTypePlan {
  sqlType: string;
  paramType: DuckDBType;
  paramSql: string; // "$N" or "$N::TIMESTAMP"
}

function planForValue(value: unknown): ColumnTypePlan | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'bigint') return { sqlType: 'BIGINT', paramType: BIGINT, paramSql: '' };
  if (typeof value === 'number') {
    return Number.isInteger(value)
      ? { sqlType: 'BIGINT', paramType: BIGINT, paramSql: '' }
      : { sqlType: 'DOUBLE', paramType: DOUBLE, paramSql: '' };
  }
  if (typeof value === 'boolean') return { sqlType: 'BOOLEAN', paramType: BOOLEAN, paramSql: '' };
  if (value instanceof Date) return { sqlType: 'TIMESTAMP', paramType: VARCHAR, paramSql: '::TIMESTAMP' };
  return { sqlType: 'VARCHAR', paramType: VARCHAR, paramSql: '' };
}

/** Scans EVERY row per column (not just the first non-null) and widens the
 *  plan when a later value doesn't fit the type picked from an earlier one —
 *  e.g. a `double precision` column where the first non-null row happens to
 *  hold a whole number (`3`) would otherwise be locked to BIGINT by
 *  `planForValue`, and a later fractional value (`3.5`) would fail to bind.
 *  Falls back to VARCHAR when every row has null in that column (safe,
 *  lossless default), and to VARCHAR when a column mixes incompatible types
 *  (e.g. number rows plus string rows) since VARCHAR can hold either. */
export function inferColumnPlans(columns: string[], rows: unknown[][]): ColumnTypePlan[] {
  const plans: (ColumnTypePlan | null)[] = columns.map(() => null);
  for (const row of rows) {
    for (let i = 0; i < columns.length; i++) {
      const candidate = planForValue(row[i]);
      if (candidate === null) continue;
      const current = plans[i];
      if (current === null) {
        plans[i] = candidate;
      } else if (current.sqlType !== candidate.sqlType) {
        plans[i] =
          current.sqlType === 'BIGINT' && candidate.sqlType === 'DOUBLE'
            ? candidate
            : current.sqlType === 'DOUBLE' && candidate.sqlType === 'BIGINT'
              ? current
              : { sqlType: 'VARCHAR', paramType: VARCHAR, paramSql: '' };
      }
    }
  }
  return plans.map((p) => p ?? { sqlType: 'VARCHAR', paramType: VARCHAR, paramSql: '' });
}

function toDuckDbParam(value: unknown): DuckDBValue {
  if (value instanceof Date) return value.toISOString();
  return value as DuckDBValue;
}

/** Inserts `rows` (already columns-matched to `plans`) into an existing,
 *  already-created DuckDB `snapshot` table on `connection`. Shared by the
 *  fresh-extract path here and the incremental-append path in
 *  `incremental-snapshot-service.ts` so both bind rows the same way (same
 *  type-widen plan, same TIMESTAMP cast handling). */
export async function insertRows(
  connection: Awaited<ReturnType<DuckDBInstance['connect']>>,
  plans: ColumnTypePlan[],
  rows: unknown[][],
): Promise<void> {
  if (rows.length === 0) return;
  const placeholders = plans.map((p, i) => `$${i + 1}${p.paramSql}`).join(', ');
  const paramTypes = plans.map((p) => p.paramType);
  const prepared = await connection.prepare(`INSERT INTO snapshot VALUES (${placeholders})`);
  for (const row of rows) {
    prepared.bind(row.map(toDuckDbParam), paramTypes);
    await prepared.run();
  }
}

/** `COPY TO ... (FORMAT PARQUET)` options, threshold-gated on row count.
 *  Row count is known from the just-fetched result set — no extra COUNT(*)
 *  round-trip or double-write to measure real file size needed. Exported so
 *  `incremental-snapshot-service.ts`'s append-and-rewrite path applies the
 *  same threshold to a table that grows past it via deltas, not only tables
 *  large enough to cross it on the very first full extract. */
export function parquetCopyOptions(rowCount: number): string {
  return rowCount > ROW_COUNT_COMPRESSION_THRESHOLD
    ? `(FORMAT PARQUET, COMPRESSION ZSTD, ROW_GROUP_SIZE ${ROW_GROUP_SIZE})`
    : '(FORMAT PARQUET)';
}

/** Best-effort upsert into `accelerateSnapshots` — the app DB is a queryable
 *  status index for the UI, never the source of truth for query execution
 *  (that stays `.meta.json` + the Parquet file). A DB write failure here must
 *  not break the accelerator, so callers never await-and-throw this. */
export async function upsertSnapshotStatus(row: {
  connectionId: string;
  cacheKey: string;
  sql: string;
  asOf?: Date | null;
  sizeBytes?: number | null;
  status: 'ready' | 'extracting' | 'failed';
  lastError?: string | null;
}): Promise<void> {
  try {
    await db
      .insert(accelerateSnapshots)
      .values({
        connectionId: row.connectionId,
        cacheKey: row.cacheKey,
        sql: row.sql,
        asOf: row.asOf ?? null,
        sizeBytes: row.sizeBytes ?? null,
        status: row.status,
        lastError: row.lastError ?? null,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [accelerateSnapshots.connectionId, accelerateSnapshots.cacheKey],
        set: {
          sql: row.sql,
          asOf: row.asOf ?? null,
          sizeBytes: row.sizeBytes ?? null,
          status: row.status,
          lastError: row.lastError ?? null,
          updatedAt: new Date(),
        },
      });
  } catch (e) {
    console.warn('[accelerator] failed to persist snapshot status (non-fatal):', e instanceof Error ? e.message : String(e));
  }
}

/** Row-fetch step for a snapshot extract. Defaults to the provider's own
 *  `executeReadOnly` (the OLTP accelerator path, unchanged). A caller can override
 *  it — e.g. the BigQuery-over-DuckDB path routes the fetch through `executeQuery`'s
 *  daily-budget gate so a BigQuery extract can never scan bytes un-budgeted. */
export type SnapshotFetchRows = (sql: string) => Promise<{ columns: string[]; rows: unknown[][] }>;

async function extractToParquet(
  provider: ConnectionProvider,
  extractSql: string,
  parquetPath: string,
  fetchRows?: SnapshotFetchRows,
): Promise<void> {
  const result = await (fetchRows ? fetchRows(extractSql) : provider.executeReadOnly(extractSql));
  const plans = inferColumnPlans(result.columns, result.rows);
  const columnList = result.columns.map((c, i) => `"${c.replace(/"/g, '""')}" ${plans[i].sqlType}`).join(', ');

  const instance = await DuckDBInstance.create(':memory:');
  const connection = await instance.connect();
  try {
    await connection.run(`CREATE TABLE snapshot (${columnList})`);
    await insertRows(connection, plans, result.rows);

    const escapedPath = parquetPath.replace(/'/g, "''");
    await connection.run(`COPY snapshot TO '${escapedPath}' ${parquetCopyOptions(result.rows.length)}`);
  } finally {
    connection.closeSync();
  }
}

/**
 * Returns the local Parquet snapshot path for `extractSql` on `connectionId`,
 * extracting fresh only when no cache exists or the cached copy is older than
 * `ttlMs`. `extractSql` is expected to already be a validated, safety-gated
 * SELECT (this service does not itself enforce read-only/AST safety — callers
 * pass SQL that already passed the provider's own safety gate).
 */
export async function ensureSnapshot(
  connectionId: string,
  provider: ConnectionProvider,
  extractSql: string,
  ttlMs: number,
  fetchRows?: SnapshotFetchRows,
): Promise<SnapshotResult> {
  const cacheKey = cacheKeyFor(extractSql);
  const lockKey = `${connectionId}:${cacheKey}`;

  const existing = inFlight.get(lockKey);
  if (existing) return existing;

  const task = (async (): Promise<SnapshotResult> => {
    const { dir, parquetPath, metaPath } = cachePaths(connectionId, cacheKey);
    const meta = await readMeta(metaPath);

    if (meta) {
      const asOf = new Date(meta.asOf);
      if (Date.now() - asOf.getTime() < ttlMs) {
        // Correct a stale `failed` status row (e.g. from a query-time DuckDB
        // error after this snapshot's own extract succeeded) now that the
        // cache is confirmed healthy — otherwise it can show failed forever.
        const sizeBytes = await stat(parquetPath).then((s) => s.size).catch(() => null);
        await upsertSnapshotStatus({ connectionId, cacheKey, sql: extractSql, asOf, sizeBytes, status: 'ready' });
        return { path: parquetPath, asOf };
      }
    }

    await mkdir(dir, { recursive: true });
    await upsertSnapshotStatus({ connectionId, cacheKey, sql: extractSql, status: 'extracting' });
    try {
      await extractToParquet(provider, extractSql, parquetPath, fetchRows);
    } catch (e) {
      await upsertSnapshotStatus({
        connectionId,
        cacheKey,
        sql: extractSql,
        status: 'failed',
        lastError: e instanceof Error ? e.message : String(e),
      });
      throw e;
    }
    const asOf = new Date();
    await writeFile(metaPath, JSON.stringify({ asOf: asOf.toISOString() } satisfies SnapshotMeta), 'utf-8');
    const sizeBytes = await stat(parquetPath).then((s) => s.size).catch(() => null);
    await upsertSnapshotStatus({ connectionId, cacheKey, sql: extractSql, asOf, sizeBytes, status: 'ready' });
    return { path: parquetPath, asOf };
  })();

  inFlight.set(lockKey, task);
  try {
    return await task;
  } finally {
    inFlight.delete(lockKey);
  }
}
