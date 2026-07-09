import { NextResponse } from 'next/server';
import { runDiscovery } from '../../../../../services/discovery-service';

export const runtime = 'nodejs';
export const maxDuration = 120;

/** POST → run inbox-gated discovery (drafts table descriptions + relationships as
 *  pending suggestions). On-demand + cost-capped. Body: { maxTables? } */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await req.json().catch(() => ({}));
  try {
    const result = await runDiscovery(id, { maxTables: body.maxTables });
    return NextResponse.json(result);
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
  }
}
