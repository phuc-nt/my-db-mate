/**
 * Incremental (watermark-based) snapshot refresh — Phase 2 of the OLAP
 * accelerator deepening. Extends `snapshot-cache-service.ts`'s full-extract
 * cache with a delta-extract-and-append path for tables that have a confirmed
 * watermark column: instead of re-extracting the whole table on every TTL
 * expiry, only rows newer than the last-seen watermark are pulled and merged
 * into the existing Parquet file.
 *
 * Cache-key stability: the key is `hash(baseExtractSql + watermarkCol)`, NOT
 * `hash(deltaSql)` — the delta SQL's `WHERE {col} > {value}` changes every
 * call (the value advances), which would defeat the cache if hashed directly.
 * The actual watermark VALUE lives in `.meta.json`, not the cache key.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { DuckDBInstance, DOUBLE, VARCHAR } from '@duckdb/node-api';
import type { ConnectionProvider } from '../connection-providers/provider-interface';
import { stat } from 'node:fs/promises';
import {
  cacheKeyFor,
  cachePaths,
  inferColumnPlans,
  inFlight,
  insertRows,
  parquetCopyOptions,
  readMeta,
  upsertSnapshotStatus,
  type SnapshotMeta,
  type SnapshotResult,
} from './snapshot-cache-service';

// Same identifier allowlist enforced at write time in watermark-config-service.ts.
// Re-checked here because `watermarkCol` is spliced directly into a WHERE-clause
// identifier position below (no bind-param support for identifiers) — this
// function must be safe even if called with an unvalidated value from a future
// caller, not just the current single call site in query-executor-service.ts.
const VALID_COLUMN_NAME = /^[A-Za-z0-9_]+$/;

// `inferColumnPlans` (snapshot-cache-service.ts) only ever emits one of these
// five SQL types, so this is the complete widening lattice for delta columns
// — not a generic DuckDB type-widening table. BIGINT -> DOUBLE mirrors
// inferColumnPlans' own mixed-column behavior (a fractional value widens a
// BIGINT-typed column to DOUBLE); anything -> VARCHAR is always safe since
// VARCHAR can hold any prior value's text form.
const SAFE_WIDENS: Record<string, string[]> = {
  BIGINT: ['DOUBLE', 'VARCHAR'],
  DOUBLE: ['VARCHAR'],
  BOOLEAN: ['VARCHAR'],
  TIMESTAMP: ['VARCHAR'],
};

/** Whether `deltaType` can safely replace `existingType` on the existing
 *  Parquet column — true only for a known-safe widen. Never true for a
 *  narrowing change (e.g. DOUBLE -> BIGINT) or an unrecognized pair, so the
 *  caller can refuse the ALTER instead of risking data loss. */
function isSafeWiden(existingType: string, deltaType: string): boolean {
  if (existingType === deltaType) return false;
  return SAFE_WIDENS[existingType]?.includes(deltaType) ?? false;
}

/** Formats `value` as a literal safe to splice into a `WHERE {col} > ...`
 *  clause. Not parameterized — this SQL is built server-side from a value the
 *  service itself extracted and stored (never from user input), but it still
 *  becomes live source SQL text, so the literal must be syntactically valid
 *  and correctly quoted/escaped for the target dialect. */
function watermarkLiteral(value: string): string {
  const asDate = new Date(value);
  if (!Number.isNaN(asDate.getTime()) && /^\d{4}-\d{2}-\d{2}/.test(value)) {
    return `'${asDate.toISOString()}'`;
  }
  if (/^-?\d+(\.\d+)?$/.test(value)) {
    return value;
  }
  return `'${value.replace(/'/g, "''")}'`;
}

/** A literal guaranteed to sort below every real value `watermarkLiteral`
 *  would produce for the same watermark column — matched to the SAME branch
 *  (date vs. numeric vs. text) as `meta.lastWatermark` so the COALESCE
 *  fallback type-checks against the column regardless of which of the three
 *  a given watermark column actually is. */
function watermarkFloor(sampleValue: string): string {
  const asDate = new Date(sampleValue);
  if (!Number.isNaN(asDate.getTime()) && /^\d{4}-\d{2}-\d{2}/.test(sampleValue)) {
    return "'0001-01-01T00:00:00.000Z'";
  }
  if (/^-?\d+(\.\d+)?$/.test(sampleValue)) {
    return '-9223372036854775808';
  }
  return "''";
}

/** Highest non-null value in `rows` at `watermarkColIndex`, ISO-formatted
 *  when the value is a Date. Returns null when every row is null there. */
function maxWatermark(rows: unknown[][], watermarkColIndex: number): string | null {
  let max: unknown = null;
  for (const row of rows) {
    const value = row[watermarkColIndex];
    if (value === null || value === undefined) continue;
    if (max === null) {
      max = value;
      continue;
    }
    const isGreater =
      value instanceof Date && max instanceof Date
        ? value.getTime() > max.getTime()
        : (value as string | number) > (max as string | number);
    if (isGreater) max = value;
  }
  if (max === null) return null;
  return max instanceof Date ? max.toISOString() : String(max);
}

/** Existing column name → DuckDB type for the already-written Parquet
 *  snapshot, read via `DESCRIBE` on the freshly created in-memory table. */
async function describeExistingColumns(connection: Awaited<ReturnType<DuckDBInstance['connect']>>): Promise<Map<string, string>> {
  const reader = await connection.runAndReadAll('DESCRIBE snapshot');
  const rows = reader.getRowsJson() as [string, string, ...unknown[]][];
  return new Map(rows.map(([name, type]) => [name, type]));
}

/** Reads the existing Parquet file into a fresh in-memory DuckDB table, adds
 *  any delta rows (widening column types first if a delta value doesn't fit
 *  the file's existing schema), then rewrites the file — DuckDB has no
 *  in-place Parquet append, so read-merge-rewrite is the only option.
 *
 *  Column widening is conservative: an ALTER is only issued for a known-safe
 *  numeric-widening step (see `isSafeWiden`). A delta column absent from the
 *  existing file, or a type change that isn't a recognized widen, throws
 *  instead of silently narrowing or dropping data — the caller treats this
 *  as a hard failure of the incremental path for this table. */
async function appendToParquet(parquetPath: string, deltaColumns: string[], deltaRows: unknown[][]): Promise<void> {
  const instance = await DuckDBInstance.create(':memory:');
  const connection = await instance.connect();
  try {
    const escapedPath = parquetPath.replace(/'/g, "''");
    await connection.run(`CREATE TABLE snapshot AS SELECT * FROM read_parquet('${escapedPath}')`);

    if (deltaRows.length > 0) {
      const deltaPlans = inferColumnPlans(deltaColumns, deltaRows);
      const existingTypes = await describeExistingColumns(connection);
      // Columns whose delta-inferred type was relabeled to the existing
      // (wider) type below — see the narrower-batch branch. The row values
      // themselves still hold the batch-local JS type (e.g. `bigint` for a
      // column relabeled DOUBLE, `number`/`boolean`/Date for one relabeled
      // VARCHAR), and DuckDB's binder rejects those against the new param
      // type, so they need converting to match, not just the plan.
      const widenTargetType = new Map<number, string>();

      for (let i = 0; i < deltaColumns.length; i++) {
        const existingType = existingTypes.get(deltaColumns[i]);
        if (existingType === undefined) {
          throw new Error(`Delta column "${deltaColumns[i]}" is not present in the existing snapshot — schema drift is not supported for incremental refresh`);
        }
        if (existingType === deltaPlans[i].sqlType) continue;
        if (isSafeWiden(existingType, deltaPlans[i].sqlType)) {
          const columnName = deltaColumns[i].replace(/"/g, '""');
          await connection.run(`ALTER TABLE snapshot ALTER COLUMN "${columnName}" TYPE ${deltaPlans[i].sqlType}`);
        } else if (isSafeWiden(deltaPlans[i].sqlType, existingType)) {
          // The delta batch's own values look narrower than the existing column
          // (e.g. every value in this small batch happens to be a whole number,
          // inferring BIGINT, while the full snapshot already holds DOUBLE or
          // VARCHAR from an earlier value elsewhere in the table). This is an
          // inference artifact of a small sample, not real schema drift — bind
          // the delta rows using the existing (wider) type instead of narrowing
          // the column.
          deltaPlans[i] = existingType === 'VARCHAR'
            ? { sqlType: 'VARCHAR', paramType: VARCHAR, paramSql: '' }
            : { sqlType: 'DOUBLE', paramType: DOUBLE, paramSql: '' };
          widenTargetType.set(i, deltaPlans[i].sqlType);
        } else {
          throw new Error(
            `Delta column "${deltaColumns[i]}" has type ${deltaPlans[i].sqlType}, incompatible with existing snapshot type ${existingType} — refusing to narrow or apply an unrecognized type change`,
          );
        }
      }
      const boundRows = widenTargetType.size === 0
        ? deltaRows
        : deltaRows.map((row) => row.map((value, i) => {
            const targetType = widenTargetType.get(i);
            if (targetType === undefined || value === null || value === undefined) return value;
            if (targetType === 'DOUBLE') return typeof value === 'bigint' ? Number(value) : value;
            if (typeof value === 'string') return value;
            return value instanceof Date ? value.toISOString() : String(value);
          }));
      await insertRows(connection, deltaPlans, boundRows);
    }

    const rowCountResult = await connection.runAndReadAll('SELECT COUNT(*) FROM snapshot');
    const totalRows = Number(rowCountResult.getRowsJson()[0][0]);
    await connection.run(`COPY snapshot TO '${escapedPath}' ${parquetCopyOptions(totalRows)}`);
  } finally {
    connection.closeSync();
  }
}

/**
 * Returns the local Parquet snapshot path for `baseExtractSql` on
 * `connectionId`, using incremental delta-extract-and-append instead of a
 * full re-extract once an initial snapshot exists. `baseExtractSql` must be
 * a plain `SELECT ... FROM table` with no existing WHERE clause tied to the
 * watermark — this function appends the watermark filter itself.
 *
 * Branches:
 * 1. No meta, or meta has no `lastWatermark` yet → full extract, seed watermark.
 * 2. Meta exists, TTL expired, delta has rows → extract delta, append, advance watermark.
 * 3. Meta exists, TTL expired, delta is empty → leave Parquet untouched, only refresh `asOf`.
 */
export async function ensureIncrementalSnapshot(
  connectionId: string,
  provider: ConnectionProvider,
  baseExtractSql: string,
  watermarkCol: string,
  ttlMs: number,
): Promise<SnapshotResult> {
  if (!VALID_COLUMN_NAME.test(watermarkCol)) {
    throw new Error(`Invalid watermark column name: ${watermarkCol}`);
  }

  const cacheKey = cacheKeyFor(`${baseExtractSql}::watermark::${watermarkCol}`);
  const lockKey = `${connectionId}:${cacheKey}`;

  const existing = inFlight.get(lockKey);
  if (existing) return existing;

  const task = (async (): Promise<SnapshotResult> => {
    const { dir, parquetPath, metaPath } = cachePaths(connectionId, cacheKey);
    const meta = await readMeta(metaPath);
    await mkdir(dir, { recursive: true });

    if (!meta || meta.lastWatermark === undefined) {
      await upsertSnapshotStatus({ connectionId, cacheKey, sql: baseExtractSql, status: 'extracting' });
      try {
        const result = await provider.executeReadOnly(baseExtractSql);
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

        const watermarkColIndex = result.columns.indexOf(watermarkCol);
        const seededWatermark = watermarkColIndex === -1 ? null : maxWatermark(result.rows, watermarkColIndex);
        const asOf = new Date();
        const newMeta: SnapshotMeta = { asOf: asOf.toISOString(), watermarkCol, lastWatermark: seededWatermark ?? undefined };
        await writeFile(metaPath, JSON.stringify(newMeta), 'utf-8');
        const sizeBytes = await stat(parquetPath).then((s) => s.size).catch(() => null);
        await upsertSnapshotStatus({ connectionId, cacheKey, sql: baseExtractSql, asOf, sizeBytes, status: 'ready' });
        return { path: parquetPath, asOf };
      } catch (e) {
        await upsertSnapshotStatus({
          connectionId,
          cacheKey,
          sql: baseExtractSql,
          status: 'failed',
          lastError: e instanceof Error ? e.message : String(e),
        });
        throw e;
      }
    }

    const asOf = new Date(meta.asOf);
    if (Date.now() - asOf.getTime() < ttlMs) {
      // Correct a stale `failed` status row (e.g. from a query-time DuckDB
      // error after this snapshot's own extract succeeded) now that the
      // cache is confirmed healthy — otherwise it can show failed forever.
      const sizeBytes = await stat(parquetPath).then((s) => s.size).catch(() => null);
      await upsertSnapshotStatus({ connectionId, cacheKey, sql: baseExtractSql, asOf, sizeBytes, status: 'ready' });
      return { path: parquetPath, asOf };
    }

    // COALESCE guards a row whose watermark column is NULL at first extract
    // (never-updated) and later transitions to a real value: a bare
    // `"col" > value` comparison never matches NULL in SQL, which would
    // permanently exclude that row from every future delta once it does get
    // updated. Falling back to a floor value below any real watermark makes
    // such a row appear in the very next delta once it is populated.
    const deltaSql = `SELECT * FROM (${baseExtractSql}) __base WHERE COALESCE("${watermarkCol}", ${watermarkFloor(meta.lastWatermark)}) > ${watermarkLiteral(meta.lastWatermark)}`;

    try {
      const delta = await provider.executeReadOnly(deltaSql);

      const newAsOf = new Date();
      if (delta.rows.length === 0) {
        const refreshedMeta: SnapshotMeta = { ...meta, asOf: newAsOf.toISOString() };
        await writeFile(metaPath, JSON.stringify(refreshedMeta), 'utf-8');
        const sizeBytes = await stat(parquetPath).then((s) => s.size).catch(() => null);
        await upsertSnapshotStatus({ connectionId, cacheKey, sql: baseExtractSql, asOf: newAsOf, sizeBytes, status: 'ready' });
        return { path: parquetPath, asOf: newAsOf };
      }

      await appendToParquet(parquetPath, delta.columns, delta.rows);

      const watermarkColIndex = delta.columns.indexOf(watermarkCol);
      const newMax = watermarkColIndex === -1 ? null : maxWatermark(delta.rows, watermarkColIndex);
      const updatedMeta: SnapshotMeta = {
        asOf: newAsOf.toISOString(),
        watermarkCol,
        lastWatermark: newMax ?? meta.lastWatermark,
      };
      await writeFile(metaPath, JSON.stringify(updatedMeta), 'utf-8');
      const sizeBytes = await stat(parquetPath).then((s) => s.size).catch(() => null);
      await upsertSnapshotStatus({ connectionId, cacheKey, sql: baseExtractSql, asOf: newAsOf, sizeBytes, status: 'ready' });
      return { path: parquetPath, asOf: newAsOf };
    } catch (e) {
      await upsertSnapshotStatus({
        connectionId,
        cacheKey,
        sql: baseExtractSql,
        status: 'failed',
        lastError: e instanceof Error ? e.message : String(e),
      });
      throw e;
    }
  })();

  inFlight.set(lockKey, task);
  try {
    return await task;
  } finally {
    inFlight.delete(lockKey);
  }
}
