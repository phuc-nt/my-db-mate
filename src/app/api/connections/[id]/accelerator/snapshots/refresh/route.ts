import { NextResponse } from 'next/server';
import { and, eq } from 'drizzle-orm';
import { db } from '../../../../../../../db/client';
import { accelerateSnapshots } from '../../../../../../../db/schema';
import { getConnection } from '../../../../../../../services/connection-service';
import { buildProvider, type ConnectionRow } from '../../../../../../../services/connection-providers/provider-factory';
import { ensureSnapshot } from '../../../../../../../services/accelerator/snapshot-cache-service';
import { ensureIncrementalSnapshot } from '../../../../../../../services/accelerator/incremental-snapshot-service';
import { getWatermarkConfig } from '../../../../../../../services/accelerator/watermark-config-service';

export const runtime = 'nodejs';

// The stored `sql` is always the per-table extract query `tryAccelerate`
// (query-executor-service.ts) builds — `SELECT * FROM <table>` — so the table
// name can be recovered from it without a separate column.
const EXTRACT_SQL_TABLE = /^SELECT \* FROM (\S+)$/;

/** Forces a re-extract for one snapshot row, bypassing its TTL — reuses
 *  `ensureSnapshot`/`ensureIncrementalSnapshot` unchanged (both already gate
 *  on `Date.now() - asOf.getTime() < ttlMs`, so `ttlMs=0` always re-extracts).
 *  No duplicated extract logic, per the phase's DRY requirement. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { cacheKey } = await req.json();
  if (typeof cacheKey !== 'string' || !cacheKey.trim()) {
    return NextResponse.json({ error: 'cacheKey required' }, { status: 400 });
  }

  const [row] = await db
    .select()
    .from(accelerateSnapshots)
    .where(and(eq(accelerateSnapshots.connectionId, id), eq(accelerateSnapshots.cacheKey, cacheKey)));
  if (!row) return NextResponse.json({ error: 'snapshot not found' }, { status: 404 });

  const conn = await getConnection(id);
  if (!conn) return NextResponse.json({ error: 'connection not found' }, { status: 404 });

  const provider = buildProvider(conn as unknown as ConnectionRow);
  try {
    const table = EXTRACT_SQL_TABLE.exec(row.sql)?.[1];
    const watermarkConfig = table ? await getWatermarkConfig(id, table) : null;
    if (watermarkConfig) {
      await ensureIncrementalSnapshot(id, provider, row.sql, watermarkConfig.watermarkCol, 0);
    } else {
      await ensureSnapshot(id, provider, row.sql, 0);
    }
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  } finally {
    await provider.close();
  }

  const [updated] = await db
    .select()
    .from(accelerateSnapshots)
    .where(and(eq(accelerateSnapshots.connectionId, id), eq(accelerateSnapshots.cacheKey, cacheKey)));
  return NextResponse.json(updated);
}
