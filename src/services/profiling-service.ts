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
import type { ConnectionProvider } from './connection-providers/provider-interface';

const DISTINCT_CAP = 50;

function ident(provider: ConnectionProvider, name: string): string {
  // name is already validated against the synced schema (allow-list), so this is
  // just dialect quoting. The strip is belt-and-suspenders.
  const safe = name.replace(/[^A-Za-z0-9_]/g, '');
  return provider.dialect === 'mysql' ? `\`${safe}\`` : `"${safe}"`;
}

/** Verify table.column exists in the synced schema — an allow-list so an
 *  LLM-supplied name can't reach the DB unchecked (defense in depth on top of
 *  the read-only physical layer). Returns the canonical names. */
async function assertKnownColumn(connectionId: string, tableName: string, columnName: string) {
  const [t] = await db.select().from(schemaTables)
    .where(and(eq(schemaTables.connectionId, connectionId), eq(schemaTables.tableName, tableName)));
  if (!t) throw new Error(`Unknown table: ${tableName}`);
  const [c] = await db.select().from(schemaColumns)
    .where(and(eq(schemaColumns.tableId, t.id), eq(schemaColumns.columnName, columnName)));
  if (!c) throw new Error(`Unknown column: ${tableName}.${columnName}`);
  return { tableName: t.tableName, columnName: c.columnName };
}

/** Profile one column; upserts a row into column_profiles. */
export async function profileColumn(connectionId: string, tableName: string, columnName: string) {
  // Allow-list check before building any SQL.
  ({ tableName, columnName } = await assertKnownColumn(connectionId, tableName, columnName));
  const provider = await getProvider(connectionId);
  try {
    const t = ident(provider, tableName);
    const c = ident(provider, columnName);

    const totalRes = await provider.executeReadOnly(`SELECT COUNT(*) AS n, COUNT(${c}) AS nn FROM ${t}`);
    const total = Number(totalRes.rows[0][0]);
    const nonNull = Number(totalRes.rows[0][1]);
    const nullRate = total > 0 ? (total - nonNull) / total : 0;

    const distinctRes = await provider.executeReadOnly(`SELECT COUNT(DISTINCT ${c}) AS d FROM ${t}`);
    const distinctCount = Number(distinctRes.rows[0][0]);

    let distinctValues: unknown[] | null = null;
    if (distinctCount > 0 && distinctCount <= DISTINCT_CAP) {
      const dv = await provider.executeReadOnly(`SELECT DISTINCT ${c} FROM ${t} WHERE ${c} IS NOT NULL LIMIT ${DISTINCT_CAP}`);
      distinctValues = dv.rows.map((r) => r[0]);
    }

    const mm = await provider.executeReadOnly(`SELECT MIN(${c}) AS mn, MAX(${c}) AS mx FROM ${t}`);
    const sample = await provider.executeReadOnly(`SELECT ${c} FROM ${t} WHERE ${c} IS NOT NULL LIMIT 5`);

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
