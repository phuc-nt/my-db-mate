import { NextResponse } from 'next/server';
import { runWidget, deleteWidget, updateWidgetLayout } from '../../../../../../services/dashboard-service';
import { isValidIsoDate } from '../../../../../../lib/sql-param';

export const runtime = 'nodejs';

/** OWNER refresh: run the widget through the choke point. Optional {from,to}
 *  (ISO dates) runs a {{from}}/{{to}} widget transiently without touching the
 *  cache; anything that isn't a plain calendar date is rejected here AND in
 *  substituteDateRange (defense in depth). */
export async function POST(req: Request, { params }: { params: Promise<{ id: string; widgetId: string }> }) {
  const { widgetId } = await params;
  const body = await req.json().catch(() => ({}));
  let range: { from: string; to: string } | undefined;
  if (body.from != null || body.to != null) {
    if (!isValidIsoDate(String(body.from)) || !isValidIsoDate(String(body.to))) {
      return NextResponse.json({ status: 'error', message: 'from/to must be YYYY-MM-DD dates' }, { status: 400 });
    }
    range = { from: String(body.from), to: String(body.to) };
  }
  const res = await runWidget(widgetId, Boolean(body.confirmed), range);
  return NextResponse.json(res);
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string; widgetId: string }> }) {
  const { widgetId } = await params;
  await deleteWidget(widgetId);
  return NextResponse.json({ ok: true });
}

/** PATCH { size?, position? } → update widget layout. */
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string; widgetId: string }> }) {
  const { widgetId } = await params;
  const body = await req.json().catch(() => ({}));
  await updateWidgetLayout(widgetId, { size: body.size, position: body.position });
  return NextResponse.json({ ok: true });
}
