import { NextResponse } from 'next/server';
import { createSchedule, deleteSchedule, listSchedules, runSchedule, setScheduleEnabled } from '../../../../../services/schedule-service';

export const runtime = 'nodejs';
export const maxDuration = 120;

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return NextResponse.json(await listSchedules(id));
}

/** POST { action:'create', ... } or { action:'run', scheduleId }. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await req.json();
  try {
    if (body.action === 'create') {
      const MODES = ['sql', 'question', 'dashboard_refresh', 'report_regenerate', 'monitor', 'metrics_digest'];
      if (!MODES.includes(body.mode)) return NextResponse.json({ error: 'unknown mode' }, { status: 400 });
      const row = await createSchedule({ connectionId: id, name: body.name, mode: body.mode, sql: body.sql, question: body.question, cron: body.cron, webhookUrl: body.webhookUrl, targetId: body.targetId, config: body.config });
      return NextResponse.json(row, { status: 201 });
    }
    if (body.action === 'run') { await runSchedule(body.scheduleId); return NextResponse.json({ ok: true }); }
    return NextResponse.json({ error: 'unknown action' }, { status: 400 });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
  }
}

/** PATCH { scheduleId, isEnabled } → toggle a schedule. */
export async function PATCH(req: Request) {
  const body = await req.json();
  if (typeof body.scheduleId !== 'string' || typeof body.isEnabled !== 'boolean') {
    return NextResponse.json({ error: 'scheduleId + isEnabled required' }, { status: 400 });
  }
  await setScheduleEnabled(body.scheduleId, body.isEnabled);
  return NextResponse.json({ ok: true });
}

/** DELETE { scheduleId } → remove a schedule (and its cron task). */
export async function DELETE(req: Request) {
  const body = await req.json();
  if (typeof body.scheduleId !== 'string') {
    return NextResponse.json({ error: 'scheduleId required' }, { status: 400 });
  }
  await deleteSchedule(body.scheduleId);
  return NextResponse.json({ ok: true });
}
