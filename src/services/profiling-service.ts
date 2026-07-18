/**
 * Column profiling (P3) — surfaces real values so the agent stops guessing enum
 * codes/formats (e.g. status 'A'/'I' vs 'active'/'inactive'). Runs read-only
 * aggregate queries through the provider. Stores distinct values when the column
 * has low cardinality, plus null rate and min/max.
 */
import { and, eq } from 'drizzle-orm';
import { db } from '../db/client';
import { columnProfiles } from '../db/intelligence-schema';
import { schemaTables, schemaColumns } from '../db/schema';
import { getProvider } from './connection-service';
import { capRows } from './safety/safety-service';
import { executeQuery } from './query-executor-service';
import { qualifiedTableRef, quoteColumn } from '../lib/table-ref';
import type { ConnectionProvider, QueryResult } from './connection-providers/provider-interface';

const DISTINCT_CAP = 50;

/** Verify table.column exists in the synced schema — an allow-list so an
 *  LLM-supplied name can't reach the DB unchecked (defense in depth on top of
 *  the read-only physical layer). Returns the canonical names + schema (the
 *  BigQuery dataset — a bare table ref is rejected by BQ's planner). */
async function assertKnownColumn(connectionId: string, tableName: string, columnName: string) {
  const [t] = await db.select().from(schemaTables)
    .where(and(eq(schemaTables.connectionId, connectionId), eq(schemaTables.tableName, tableName)));
  if (!t) throw new Error(`Unknown table: ${tableName}`);
  const [c] = await db.select().from(schemaColumns)
    .where(and(eq(schemaColumns.tableId, t.id), eq(schemaColumns.columnName, columnName)));
  if (!c) throw new Error(`Unknown column: ${tableName}.${columnName}`);
  return { tableName: t.tableName, columnName: c.columnName, schemaName: t.schemaName };
}

/** Run one profiling read. Non-BigQuery keeps the historical direct
 *  `executeReadOnly` (app-internal bounded reads, unchanged behavior). BigQuery
 *  goes through the choke point's budgeted path as maintenance actor
 *  'profiling' — dry-run estimate → daily-budget reservation (half-budget
 *  low-tier ceiling) → run under maximumBytesBilled → reconcile — the same
 *  admission anomaly/monitor use. A budget block throws with the block reason
 *  so per-column try/catch reports it as a failed column, never a crash. */
async function runProfilingRead(connectionId: string, provider: ConnectionProvider, sql: string): Promise<QueryResult> {
  if (provider.dialect !== 'bigquery') return provider.executeReadOnly(sql);
  const res = await executeQuery({ connectionId, sql, actor: 'profiling', backgroundBudgeted: true });
  if (res.status !== 'ok') throw new Error(res.status === 'blocked' ? (res.blockedReason ?? 'blocked') : (res.errorMessage ?? 'error'));
  return res.result!;
}

/** Profile one column; upserts a row into column_profiles. */
export async function profileColumn(connectionId: string, tableName: string, columnName: string) {
  // Allow-list check before building any SQL.
  const known = await assertKnownColumn(connectionId, tableName, columnName);
  ({ tableName, columnName } = known);
  const provider = await getProvider(connectionId);
  try {
    const t = qualifiedTableRef(provider.dialect, tableName, known.schemaName);
    const c = quoteColumn(provider.dialect, columnName);
    const read = (sql: string) => runProfilingRead(connectionId, provider, sql);

    const totalRes = await read(`SELECT COUNT(*) AS n, COUNT(${c}) AS nn FROM ${t}`);
    const total = Number(totalRes.rows[0][0]);
    const nonNull = Number(totalRes.rows[0][1]);
    const nullRate = total > 0 ? (total - nonNull) / total : 0;

    const distinctRes = await read(`SELECT COUNT(DISTINCT ${c}) AS d FROM ${t}`);
    const distinctCount = Number(distinctRes.rows[0][0]);

    let distinctValues: unknown[] | null = null;
    if (distinctCount > 0 && distinctCount <= DISTINCT_CAP) {
      const dv = await read(capRows(`SELECT DISTINCT ${c} FROM ${t} WHERE ${c} IS NOT NULL`, DISTINCT_CAP, provider.dialect));
      distinctValues = dv.rows.map((r) => r[0]);
    }

    const mm = await read(`SELECT MIN(${c}) AS mn, MAX(${c}) AS mx FROM ${t}`);
    const sample = await read(capRows(`SELECT ${c} FROM ${t} WHERE ${c} IS NOT NULL`, 5, provider.dialect));

    const existing = await db.select().from(columnProfiles).where(and(
      eq(columnProfiles.connectionId, connectionId), eq(columnProfiles.tableName, tableName), eq(columnProfiles.columnName, columnName)));
    const values = {
      distinctValues, nullRate,
      minValue: mm.rows[0][0] == null ? null : String(mm.rows[0][0]),
      maxValue: mm.rows[0][1] == null ? null : String(mm.rows[0][1]),
      sampleValues: sample.rows.map((r) => r[0]),
      totalRows: total,
      profiledAt: new Date(),
    };
    if (existing[0]) await db.update(columnProfiles).set(values).where(eq(columnProfiles.id, existing[0].id));
    else await db.insert(columnProfiles).values({ connectionId, tableName, columnName, ...values });

    return { total, nullRate, distinctCount, distinctValues };
  } finally {
    await provider.close();
  }
}

export async function getColumnProfile(connectionId: string, tableName: string, columnName: string) {
  const [row] = await db.select().from(columnProfiles).where(and(
    eq(columnProfiles.connectionId, connectionId), eq(columnProfiles.tableName, tableName), eq(columnProfiles.columnName, columnName)));
  return row ?? null;
}
