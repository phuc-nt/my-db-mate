/**
 * CRUD for per-(connection,table) incremental-refresh watermark config
 * (Phase 2 of the OLAP accelerator deepening). A row only exists once the
 * user has explicitly confirmed a watermark column via the UI — nothing here
 * auto-creates a config from `detectWatermarkColumn`'s suggestion.
 */
import { and, eq } from 'drizzle-orm';
import { db } from '../../db/client';
import { accelerateWatermarkConfigs } from '../../db/schema';

// Same identifier allowlist as schema-browser-service.ts's `safe` column-name
// guard — `watermarkCol` is spliced directly into a WHERE clause identifier
// position in incremental-snapshot-service.ts (no bind-param support for
// identifiers), so it must be constrained at the write boundary, not just
// escaped at use time.
const VALID_COLUMN_NAME = /^[A-Za-z0-9_]+$/;

export async function getWatermarkConfig(connectionId: string, tableName: string) {
  const [row] = await db
    .select()
    .from(accelerateWatermarkConfigs)
    .where(and(eq(accelerateWatermarkConfigs.connectionId, connectionId), eq(accelerateWatermarkConfigs.tableName, tableName)));
  return row ?? null;
}

export async function listWatermarkConfigs(connectionId: string) {
  return db.select().from(accelerateWatermarkConfigs).where(eq(accelerateWatermarkConfigs.connectionId, connectionId));
}

/** Creates or replaces the watermark column for a (connection, table) pair —
 *  called only after the user confirms/changes the column in the UI. */
export async function setWatermarkConfig(connectionId: string, tableName: string, watermarkCol: string) {
  if (!VALID_COLUMN_NAME.test(watermarkCol)) {
    throw new Error(`Invalid watermark column name: ${watermarkCol}`);
  }
  const existing = await getWatermarkConfig(connectionId, tableName);
  if (existing) {
    const [row] = await db
      .update(accelerateWatermarkConfigs)
      .set({ watermarkCol, lastWatermark: null, updatedAt: new Date() })
      .where(eq(accelerateWatermarkConfigs.id, existing.id))
      .returning();
    return row;
  }
  const [row] = await db
    .insert(accelerateWatermarkConfigs)
    .values({ connectionId, tableName, watermarkCol })
    .returning();
  return row;
}

/** Disables incremental refresh for a table — deletes the config row so
 *  `tryAccelerate` falls back to the original full-extract `ensureSnapshot`. */
export async function deleteWatermarkConfig(connectionId: string, tableName: string) {
  await db
    .delete(accelerateWatermarkConfigs)
    .where(and(eq(accelerateWatermarkConfigs.connectionId, connectionId), eq(accelerateWatermarkConfigs.tableName, tableName)));
}
