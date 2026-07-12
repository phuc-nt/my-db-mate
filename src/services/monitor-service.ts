/**
 * Data-drift monitor (snapshot-diff, deliberately NOT ML): each run captures
 * rowCount + per-numeric-column nullRate/avg for the configured tables, diffs
 * against the previous capture, and alerts past explicit thresholds.
 *
 * Safety: table/column names are allow-listed against the synced schema before
 * any interpolation, and the metric query runs through executeQuery with
 * skipRiskGate (app-generated bounded aggregates; audit trail preserved,
 * no unattended needs_confirmation stall).
 */
import { and, desc, eq } from 'drizzle-orm';
import { db } from '../db/client';
import { monitorSnapshots } from '../db/monitor-schema';
import { schemaTables, schemaColumns } from '../db/schema';
import { executeQuery } from './query-executor-service';
export { diffSnapshots, DEFAULT_THRESHOLDS } from '../lib/monitor-diff';
export type { MonitorThresholds, MonitorFinding, Snapshot } from '../lib/monitor-diff';
import type { Snapshot } from '../lib/monitor-diff';

const NUMERIC_RE = /int|numeric|real|float|double|decimal|money/i;
const MAX_COLS = 10;

const quote = (dialect: string, name: string) => {
  const safe = name.replace(/[^A-Za-z0-9_]/g, '');
  return dialect === 'mysql' ? `\`${safe}\`` : dialect === 'mssql' ? `[${safe}]` : `"${safe}"`;
};

/** Capture metrics for ONE table (allow-listed against synced schema). */
export async function captureSnapshot(connectionId: string, dialect: string, tableName: string): Promise<Snapshot | { error: string }> {
  const [t] = await db.select().from(schemaTables)
    .where(and(eq(schemaTables.connectionId, connectionId), eq(schemaTables.tableName, tableName)));
  if (!t) return { error: `Unknown table: ${tableName}` };
  const cols = await db.select().from(schemaColumns).where(eq(schemaColumns.tableId, t.id));
  const numericCols = cols.filter((c) => NUMERIC_RE.test(c.dataType)).slice(0, MAX_COLS);

  const qt = quote(dialect, t.tableName);
  // One aggregate pass: COUNT(*) + per-column null counts and averages.
  const parts = [`COUNT(*) AS row_count`];
  for (const c of numericCols) {
    const qc = quote(dialect, c.columnName);
    const alias = c.columnName.replace(/[^A-Za-z0-9_]/g, '');
    parts.push(`SUM(CASE WHEN ${qc} IS NULL THEN 1 ELSE 0 END) AS nulls_${alias}`);
    parts.push(`AVG(${qc}) AS avg_${alias}`);
  }
  const sql = `SELECT ${parts.join(', ')} FROM ${qt}`;
  const res = await executeQuery({ connectionId, sql, actor: 'monitor', skipRiskGate: true });
  if (res.status !== 'ok' || !res.result) return { error: res.errorMessage ?? res.blockedReason ?? res.status };

  const row = res.result.rows[0] ?? [];
  const idx = new Map(res.result.columns.map((c, i) => [c.toLowerCase(), i]));
  const num = (name: string): number | null => {
    const i = idx.get(name.toLowerCase());
    if (i == null) return null;
    const v = row[i];
    return v == null ? null : Number(v);
  };
  const rowCount = num('row_count') ?? 0;
  const columns: Snapshot['columns'] = {};
  for (const c of numericCols) {
    const alias = c.columnName.replace(/[^A-Za-z0-9_]/g, '');
    const nulls = num(`nulls_${alias}`) ?? 0;
    columns[c.columnName] = {
      nullRate: rowCount > 0 ? nulls / rowCount : 0,
      avg: num(`avg_${alias}`),
    };
  }
  return { rowCount, columns };
}

/** Latest stored snapshot for (schedule, table). */
export async function latestSnapshot(scheduleId: string, tableName: string) {
  const [row] = await db.select().from(monitorSnapshots)
    .where(and(eq(monitorSnapshots.scheduleId, scheduleId), eq(monitorSnapshots.tableName, tableName)))
    .orderBy(desc(monitorSnapshots.capturedAt)).limit(1);
  return row ?? null;
}

const KEEP_SNAPSHOTS = 30;

export async function storeSnapshot(scheduleId: string, connectionId: string, tableName: string, metrics: Snapshot) {
  await db.insert(monitorSnapshots).values({ scheduleId, connectionId, tableName, metrics });
  // Prune beyond the newest KEEP_SNAPSHOTS.
  const all = await db.select({ id: monitorSnapshots.id }).from(monitorSnapshots)
    .where(and(eq(monitorSnapshots.scheduleId, scheduleId), eq(monitorSnapshots.tableName, tableName)))
    .orderBy(desc(monitorSnapshots.capturedAt));
  for (const old of all.slice(KEEP_SNAPSHOTS)) {
    await db.delete(monitorSnapshots).where(eq(monitorSnapshots.id, old.id));
  }
}
