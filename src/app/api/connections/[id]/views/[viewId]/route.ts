import { NextResponse } from 'next/server';
import { deleteView, updateView, VirtualViewError } from '../../../../../../services/virtual-view-service';

export const runtime = 'nodejs';

/** Edit a view, or disable it without losing the definition. A disabled view
 *  stops being offered to the agent but stays on the page, so retiring a
 *  definition is reversible and its history remains readable. */
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string; viewId: string }> }) {
  const { id, viewId } = await params;
  const body = await req.json();
  try {
    const view = await updateView({
      connectionId: id,
      id: viewId,
      name: typeof body?.name === 'string' ? body.name : undefined,
      sql: typeof body?.sql === 'string' ? body.sql : undefined,
      description: typeof body?.description === 'string' ? body.description : undefined,
      isDisabled: typeof body?.isDisabled === 'boolean' ? body.isDisabled : undefined,
    });
    return NextResponse.json({ view });
  } catch (e) {
    if (e instanceof VirtualViewError) return NextResponse.json({ error: e.message }, { status: 400 });
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string; viewId: string }> }) {
  const { id, viewId } = await params;
  await deleteView(id, viewId);
  return NextResponse.json({ ok: true });
}
