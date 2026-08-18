import { NextResponse } from 'next/server';
import { createView, listViews, VirtualViewError } from '../../../../../services/virtual-view-service';

export const runtime = 'nodejs';

/** The curated views defined on this connection. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return NextResponse.json({ views: await listViews(id) });
}

/**
 * Define a view. Everything that can be checked is checked here, at save time:
 * the SQL must pass the safety layer, stay inside the governed scope, and probe
 * cleanly for its column list. A view that cannot be saved is far cheaper than
 * one that fails for every reader later, so validation errors come back as 400
 * with the reason intact rather than a generic failure.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await req.json();
  try {
    const view = await createView({
      connectionId: id,
      name: String(body?.name ?? ''),
      sql: String(body?.sql ?? ''),
      description: typeof body?.description === 'string' ? body.description : undefined,
    });
    return NextResponse.json({ view });
  } catch (e) {
    if (e instanceof VirtualViewError) return NextResponse.json({ error: e.message }, { status: 400 });
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
