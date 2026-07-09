import { NextResponse } from 'next/server';
import { getNotebook, deleteNotebook, setNotebookShare } from '../../../../services/notebook-service';

export const runtime = 'nodejs';

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const nb = await getNotebook(id);
  if (!nb) return NextResponse.json({ error: 'not found' }, { status: 404 });
  return NextResponse.json(nb);
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await req.json();
  if (typeof body.share === 'boolean') {
    const slug = await setNotebookShare(id, body.share);
    return NextResponse.json({ shareSlug: slug });
  }
  return NextResponse.json({ ok: true });
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await deleteNotebook(id);
  return NextResponse.json({ ok: true });
}
