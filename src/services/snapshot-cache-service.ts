/**
 * Snapshot cache (DuckDB accelerator foundation, P1) — extract-once-per-TTL.
 * Runs an "extract" SQL through the connection's OWN `provider.executeReadOnly()`
 * (no bypass of the safety gate, no separate connection), writes the rows to a
 * local Parquet file via DuckDB's own node binding, and reuses that file for
 * repeat calls within the TTL window instead of re-querying the source DB.
 *
 * This is the shared foundation for both the DuckDB accelerator (query routing,
 * a later phase) and any future Parquet-export feature — one cache mechanism,
 * multiple consumers.
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DuckDBInstance, BIGINT, DOUBLE, BOOLEAN, VARCHAR, type DuckDBType, type DuckDBValue } from '@duckdb/node-api';
import type { ConnectionProvider } from './connection-providers/provider-interface';

const CACHE_ROOT = path.join(process.cwd(), '.cache', 'snapshots');

interface SnapshotMeta {
  asOf: string; // ISO timestamp
}

export interface SnapshotResult {
  path: string;
  asOf: Date;
}

// In-memory lock so two near-simultaneous calls for the same cache key don't
// both extract — self-host single-process single-user, no distributed lock needed.
const inFlight = new Map<string, Promise<SnapshotResult>>();

function cacheKeyFor(extractSql: string): string {
  return createHash('sha256').update(extractSql).digest('hex').slice(0, 16);
}

function cachePaths(connectionId: string, cacheKey: string) {
  const dir = path.join(CACHE_ROOT, connectionId);
  return {
    dir,
    parquetPath: path.join(dir, `${cacheKey}.parquet`),
    metaPath: path.join(dir, `${cacheKey}.meta.json`),
  };
}

async function readMeta(metaPath: string): Promise<SnapshotMeta | null> {
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
interface ColumnTypePlan {
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
function inferColumnPlans(columns: string[], rows: unknown[][]): ColumnTypePlan[] {
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

async function extractToParquet(provider: ConnectionProvider, extractSql: string, parquetPath: string): Promise<void> {
  const result = await provider.executeReadOnly(extractSql);
  const plans = inferColumnPlans(result.columns, result.rows);
  const columnList = result.columns.map((c, i) => `"${c.replace(/"/g, '""')}" ${plans[i].sqlType}`).join(', ');

  const instance = await DuckDBInstance.create(':memory:');
  const connection = await instance.connect();
  try {
    await connection.run(`CREATE TABLE snapshot (${columnList})`);

    if (result.rows.length > 0) {
      const placeholders = plans.map((p, i) => `$${i + 1}${p.paramSql}`).join(', ');
      const paramTypes = plans.map((p) => p.paramType);
      const prepared = await connection.prepare(`INSERT INTO snapshot VALUES (${placeholders})`);
      for (const row of result.rows) {
        prepared.bind(row.map(toDuckDbParam), paramTypes);
        await prepared.run();
      }
    }

    const escapedPath = parquetPath.replace(/'/g, "''");
    await connection.run(`COPY snapshot TO '${escapedPath}' (FORMAT PARQUET)`);
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
        return { path: parquetPath, asOf };
      }
    }

    await mkdir(dir, { recursive: true });
    await extractToParquet(provider, extractSql, parquetPath);
    const asOf = new Date();
    await writeFile(metaPath, JSON.stringify({ asOf: asOf.toISOString() } satisfies SnapshotMeta), 'utf-8');
    return { path: parquetPath, asOf };
  })();

  inFlight.set(lockKey, task);
  try {
    return await task;
  } finally {
    inFlight.delete(lockKey);
  }
}
