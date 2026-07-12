import { NextResponse } from 'next/server';
import { detectAnomalies } from '../../../../../services/anomaly-service';

export const runtime = 'nodejs';

/** POST { table, column } → distribution/outlier report for one numeric column.
 *  Pure SQL (no LLM); identifiers are validated against the synced schema inside
 *  detectAnomalies (assertKnownColumn). */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await req.json().catch(() => ({}));
  if (typeof body.table !== 'string' || typeof body.column !== 'string') {
    return NextResponse.json({ error: 'table + column required' }, { status: 400 });
  }
  try {
    return NextResponse.json(await detectAnomalies(id, body.table, body.column));
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
  }
}
