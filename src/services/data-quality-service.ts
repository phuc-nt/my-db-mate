/**
 * Data-quality profiling (P10-B2) — a MANUAL, inline scan that surfaces likely
 * data problems: high NULL rate, single-value columns, and near-unique (id-like)
 * columns that add no analytical value.
 *
 * Design (from adversarial review):
 * - MANUAL trigger, run INLINE in the request (cost-capped + the route's
 *   maxDuration). NOT fire-and-forget after sync — a request handler has no
 *   background runtime to finish the work.
 * - Profiling reuses profileColumn, which reads the target DB DIRECTLY (not through
 *   the query-executor choke point) — so this is NOT audited/risk-gated. The column
 *   allow-list inside profileColumn is the safety here; we do not claim otherwise.
 * - Per-column try/catch: one failing column doesn't sink the scan, and the result
 *   reports scanned/failed so the UI can show "partial (N/M)" instead of pretending
 *   the scan is complete.
 */
import { eq } from 'drizzle-orm';
import { db } from '../db/client';
import { schemaTables, schemaColumns } from '../db/schema';
import { columnProfiles } from '../db/intelligence-schema';
import { profileColumn } from './profiling-service';

const DEFAULT_MAX_COLUMNS = Number(process.env.DATA_QUALITY_MAX_COLUMNS ?? 60);
const HIGH_NULL_RATE = 0.5;

export interface ProfileRunResult {
  scanned: number;
  failed: number;
  totalColumns: number;
}

/** Profile up to maxColumns of the connection's columns (inline). Idempotent —
 *  profileColumn upserts. Per-column try/catch so a failure is counted, not fatal. */
export async function profileConnection(connectionId: string, opts?: { maxColumns?: number }): Promise<ProfileRunResult> {
  const maxColumns = opts?.maxColumns ?? DEFAULT_MAX_COLUMNS;
  const tables = await db.select().from(schemaTables).where(eq(schemaTables.connectionId, connectionId));

  let scanned = 0, failed = 0, totalColumns = 0;
  outer: for (const t of tables) {
    const cols = await db.select().from(schemaColumns).where(eq(schemaColumns.tableId, t.id));
    for (const c of cols) {
      totalColumns++;
      if (scanned + failed >= maxColumns) continue; // still count total, stop scanning
      try {
        await profileColumn(connectionId, t.tableName, c.columnName);
        scanned++;
      } catch {
        failed++;
      }
      if (scanned + failed >= maxColumns) break outer;
    }
  }
  return { scanned, failed, totalColumns };
}

export interface HealthFlag {
  tableName: string;
  columnName: string;
  issue: 'high_null' | 'single_value' | 'near_unique';
  detail: string;
}

export interface DataHealth {
  flags: HealthFlag[];
  profiledColumns: number;
  totalColumns: number;
}

/**
 * Read the stored profiles and classify data-quality issues. Completeness is
 * profiledColumns vs totalColumns so the UI can badge a partial scan (red-team H4).
 * near-unique uses a NUMERIC distinct estimate (distinctValues length is capped, so
 * we treat a full-capped distinct list on a large table as "high cardinality"). PK
 * columns are excluded (being unique is their job).
 */
export async function getDataHealth(connectionId: string): Promise<DataHealth> {
  const profiles = await db.select().from(columnProfiles).where(eq(columnProfiles.connectionId, connectionId));
  const pkCols = new Set<string>();
  const tables = await db.select().from(schemaTables).where(eq(schemaTables.connectionId, connectionId));
  let totalColumns = 0;
  for (const t of tables) {
    const cols = await db.select().from(schemaColumns).where(eq(schemaColumns.tableId, t.id));
    totalColumns += cols.length;
    for (const c of cols) if (c.isPrimaryKey) pkCols.add(`${t.tableName}.${c.columnName}`);
  }

  const flags: HealthFlag[] = [];
  for (const p of profiles) {
    const key = `${p.tableName}.${p.columnName}`;
    if (pkCols.has(key)) continue;
    const total = p.totalRows ?? 0;
    const distinctLen = (p.distinctValues ?? []).length;

    if (p.nullRate != null && p.nullRate >= HIGH_NULL_RATE) {
      flags.push({ tableName: p.tableName, columnName: p.columnName, issue: 'high_null', detail: `${(p.nullRate * 100).toFixed(0)}% NULL` });
    }
    // single-value: exactly one distinct non-null value.
    if (distinctLen === 1) {
      flags.push({ tableName: p.tableName, columnName: p.columnName, issue: 'single_value', detail: 'only one distinct value' });
    }
    // near-unique: profileColumn stores distinctValues ONLY for small cardinality,
    // so "no stored distinct list on a large table" means high cardinality (id-like)
    // — BUT an all-NULL column also has distinctValues null (DISTINCT ignores NULL),
    // so exclude near-all-NULL columns (they're a high_null issue, not id-like).
    if (total > 100 && distinctLen === 0 && (p.nullRate ?? 0) < 0.99) {
      flags.push({ tableName: p.tableName, columnName: p.columnName, issue: 'near_unique', detail: `high cardinality over ${total.toLocaleString()} rows (id-like?)` });
    }
  }

  return { flags, profiledColumns: profiles.length, totalColumns };
}
