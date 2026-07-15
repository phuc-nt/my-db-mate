import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { db } from '../../../../../../db/client';
import { accelerateSnapshots } from '../../../../../../db/schema';

export const runtime = 'nodejs';

/** Lists every persisted snapshot status row for a connection — the queryable
 *  index Phase 1 writes alongside the Parquet + .meta.json source of truth. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const rows = await db.select().from(accelerateSnapshots).where(eq(accelerateSnapshots.connectionId, id));
  return NextResponse.json(rows);
}
