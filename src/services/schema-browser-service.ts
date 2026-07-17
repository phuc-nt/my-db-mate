/**
 * Schema Browser service (P9-A1). Fetch sample rows for a table WITHOUT letting a
 * client build SQL: the caller passes {table}, we allow-list it against the synced
 * schema, quote it per-dialect, and run a bounded `SELECT * ... LIMIT 50` through
 * the query-executor choke point with skipRiskGate (a LIMIT 50 is known-cheap, so
 * we skip the EXPLAIN — red-team H1: the generic /execute route has no skipRiskGate,
 * so a raw SELECT * would hit the risk gate and return needs_confirmation, not rows).
 */
import { and, eq } from 'drizzle-orm';
import { db } from '../db/client';
import { schemaTables } from '../db/schema';
import { getProvider } from './connection-service';
import { executeQuery } from './query-executor-service';
import { capRows } from './safety/safety-service';

const SAMPLE_LIMIT = 50;

export type SampleResult =
  | { status: 'ok'; columns: string[]; rows: unknown[][] }
  | { status: 'error'; message: string };

export async function sampleRows(connectionId: string, table: string): Promise<SampleResult> {
  // Allow-list: the table must exist in the synced schema. This is what makes the
  // string interpolation below safe (plus the physical read-only layer).
  const [t] = await db.select().from(schemaTables)
    .where(and(eq(schemaTables.connectionId, connectionId), eq(schemaTables.tableName, table)));
  if (!t) return { status: 'error', message: `Unknown table: ${table}` };

  const provider = await getProvider(connectionId);
  const dialect = provider.dialect;
  // BigQuery: explicit cost-safety block. Schema-browser sampling runs unattended-ish
  // without the daily-byte-budget wiring, so it's blocked (like profiling/eval) rather
  // than left in the interactive dry-run path. Return the typed message (this surface
  // reports errors as a result, doesn't throw), and close the provider we opened.
  if (dialect === 'bigquery') {
    await provider.close();
    return { status: 'error', message: 'Schema browser query execution is not yet supported for BigQuery connections.' };
  }
  const safe = t.tableName.replace(/[^A-Za-z0-9_]/g, '');
  // BigQuery is blocked above, so only OLTP dialects reach here.
  const quoted = dialect === 'mysql' ? `\`${safe}\`` : dialect === 'mssql' ? `[${safe}]` : `"${safe}"`;
  await provider.close(); // executeQuery opens its own provider

  const res = await executeQuery({
    connectionId,
    // Dialect-aware row cap: SQL Server has no LIMIT (capRows uses TOP/OFFSET).
    sql: capRows(`SELECT * FROM ${quoted}`, SAMPLE_LIMIT, dialect),
    actor: 'browse',
    skipRiskGate: true,
  });
  if (res.status !== 'ok') return { status: 'error', message: res.blockedReason ?? res.errorMessage ?? res.status };
  return { status: 'ok', columns: res.result!.columns, rows: res.result!.rows };
}
