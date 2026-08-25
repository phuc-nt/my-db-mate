/**
 * Column profiling (P3) — surfaces real values so the agent stops guessing enum
 * codes/formats (e.g. status 'A'/'I' vs 'active'/'inactive'). Runs read-only
 * aggregate queries through the provider. Stores distinct values when the column
 * has low cardinality, plus null rate and min/max.
 */
import { and, eq } from 'drizzle-orm';
import { db } from '@/core/db/client';
import { columnProfiles } from '@/core/db/intelligence-schema';
import { schemaTables, schemaColumns } from '@/core/db/schema';
import { getProvider } from '@/core/connections/connection-service';
import { capRows } from '@/core/safety/safety-service';
import { executeQuery } from '@/core/execution/query-executor-service';
import { qualifiedTableRef, quoteColumn } from '@/lib/table-ref';
import { composeSchemaPrefix } from '@/lib/table-catalog-prefix';
import { getScope, isScopeActive, isRefInScope } from '@/core/boundary/schema-scope-service';
import type { ConnectionProvider, QueryResult } from '@/core/connections/providers/provider-interface';

const DISTINCT_CAP = 50;

/** Verify table.column exists in the synced schema — an allow-list so an
 *  LLM-supplied name can't reach the DB unchecked (defense in depth on top of
 *  the read-only physical layer). Returns the canonical names + schema (the
 *  BigQuery dataset — a bare table ref is rejected by BQ's planner). */
async function assertKnownColumn(connectionId: string, tableName: string, columnName: string) {
  const [t] = await db.select().from(schemaTables)
    .where(and(eq(schemaTables.connectionId, connectionId), eq(schemaTables.tableName, tableName)));
  if (!t) throw new Error(`Unknown table: ${tableName}`);
  // The governed boundary applies to profiling too: its reads sample real
  // values, so an out-of-scope table would leak exactly the data the scope
  // exists to withhold. Checked on the table (not the generated SQL) because
  // every statement below is built from this one allow-listed table.
  const scope = await getScope(connectionId);
  if (isScopeActive(scope) && !isRefInScope(scope, { schemaName: t.schemaName, tableName: t.tableName })) {
    throw new Error(`Table ${tableName} is outside the governed scope for this connection`);
  }
  const [c] = await db.select().from(schemaColumns)
    .where(and(eq(schemaColumns.tableId, t.id), eq(schemaColumns.columnName, columnName)));
  if (!c) throw new Error(`Unknown column: ${tableName}.${columnName}`);
  return { tableName: t.tableName, columnName: c.columnName, schemaName: t.schemaName, catalogName: t.catalogName };
}

/** Run one profiling read. Non-BigQuery keeps the historical direct
 *  `executeReadOnly` (app-internal bounded reads over a table `assertKnownColumn`
 *  already checked against the governed scope, unchanged behavior). BigQuery
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
    const t = qualifiedTableRef(
      provider.dialect,
      tableName,
      composeSchemaPrefix(provider.dialect, known.catalogName, known.schemaName),
    );
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
