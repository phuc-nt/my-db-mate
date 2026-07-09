import { NextResponse } from 'next/server';
import { runWidget, deleteWidget } from '../../../../../../services/dashboard-service';

export const runtime = 'nodejs';

/** OWNER refresh: run the widget through the choke point and cache the result. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string; widgetId: string }> }) {
  const { widgetId } = await params;
  const { confirmed } = await req.json().catch(() => ({}));
  const res = await runWidget(widgetId, Boolean(confirmed));
  return NextResponse.json(res);
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string; widgetId: string }> }) {
  const { widgetId } = await params;
  await deleteWidget(widgetId);
  return NextResponse.json({ ok: true });
}
