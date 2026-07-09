import { NextResponse } from 'next/server';
import { getReportLatest, deleteReport, setReportShare } from '../../../../services/report-service';

export const runtime = 'nodejs';

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const r = await getReportLatest(id);
  if (!r) return NextResponse.json({ error: 'not found' }, { status: 404 });
  return NextResponse.json(r);
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await req.json();
  if (typeof body.share === 'boolean') {
    const slug = await setReportShare(id, body.share);
    return NextResponse.json({ shareSlug: slug });
  }
  return NextResponse.json({ ok: true });
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await deleteReport(id);
  return NextResponse.json({ ok: true });
}
