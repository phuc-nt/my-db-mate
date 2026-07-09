import { NextResponse } from 'next/server';
import { getDashboard, renameDashboard, deleteDashboard, setShare } from '../../../../services/dashboard-service';

export const runtime = 'nodejs';

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const dash = await getDashboard(id);
  if (!dash) return NextResponse.json({ error: 'not found' }, { status: 404 });
  return NextResponse.json(dash);
}

/** Rename, or toggle/regenerate the share slug. { name } or { share: boolean }. */
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await req.json();
  if (typeof body.name === 'string') await renameDashboard(id, body.name.trim());
  if (typeof body.share === 'boolean') {
    const slug = await setShare(id, body.share);
    return NextResponse.json({ shareSlug: slug });
  }
  return NextResponse.json({ ok: true });
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await deleteDashboard(id);
  return NextResponse.json({ ok: true });
}
