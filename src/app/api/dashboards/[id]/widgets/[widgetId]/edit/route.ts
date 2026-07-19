import { NextResponse } from 'next/server';
import { proposeWidgetEdit, applyWidgetEdit } from '../../../../../../../services/widget-edit-service';

export const runtime = 'nodejs';

/** POST { instruction } → AI edit proposal (probed, NOT applied). */
export async function POST(req: Request, { params }: { params: Promise<{ widgetId: string }> }) {
  const { widgetId } = await params;
  const body = await req.json().catch(() => ({}));
  const instruction = typeof body.instruction === 'string' ? body.instruction.slice(0, 1000) : '';
  if (!instruction.trim()) return NextResponse.json({ ok: false, error: 'instruction required' }, { status: 400 });
  return NextResponse.json(await proposeWidgetEdit({ widgetId, instruction }));
}

/** PUT { sql, chartSpec?, title?, confirmed? } → apply (run-before-swap; the
 *  server re-gates — the proposal from the client is untrusted). The widget's
 *  connection comes from its row, never the body. */
export async function PUT(req: Request, { params }: { params: Promise<{ widgetId: string }> }) {
  const { widgetId } = await params;
  const body = await req.json().catch(() => ({}));
  if (typeof body.sql !== 'string' || !body.sql.trim()) {
    return NextResponse.json({ status: 'error', message: 'sql required' }, { status: 400 });
  }
  const res = await applyWidgetEdit({
    widgetId,
    sql: body.sql,
    chartSpec: body.chartSpec,
    title: typeof body.title === 'string' ? body.title : undefined,
    confirmed: Boolean(body.confirmed),
  });
  return NextResponse.json(res);
}
