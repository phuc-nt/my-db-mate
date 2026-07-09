import { NextResponse } from 'next/server';
import { pinWidget } from '../../../../../services/dashboard-service';

export const runtime = 'nodejs';

/** Pin a chat result as a widget. Safety-validates + risk-tiers + blocks sensitive (C4). */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { connectionId, title, sql, chartSpec } = await req.json();
  if (typeof connectionId !== 'string' || typeof sql !== 'string' || !sql.trim()) {
    return NextResponse.json({ error: 'connectionId and sql required' }, { status: 400 });
  }
  const res = await pinWidget({ dashboardId: id, connectionId, title: (title ?? 'Untitled').toString(), sql, chartSpec });
  if (!res.ok) return NextResponse.json({ error: res.reason }, { status: 200 });
  return NextResponse.json({ widgetId: res.widgetId }, { status: 201 });
}
