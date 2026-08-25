import { NextResponse } from 'next/server';
import { previewDefinition, VirtualViewError } from '@/core/boundary/virtual-view-service';

export const runtime = 'nodejs';

/**
 * Run a candidate definition and show the first rows.
 *
 * Validated exactly as saving validates — safety layer, then the governed table
 * scope — so a definition that would be refused at save time is refused here,
 * on the author's screen, rather than after they have committed to it.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await req.json();
  try {
    const out = await previewDefinition({ connectionId: id, sql: String(body?.sql ?? '') });
    return NextResponse.json(out);
  } catch (e) {
    if (e instanceof VirtualViewError) return NextResponse.json({ error: e.message }, { status: 400 });
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
