import { NextResponse } from 'next/server';
import { createSchedule, listSchedules, runSchedule } from '../../../../../services/schedule-service';

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
      const row = await createSchedule({ connectionId: id, name: body.name, mode: body.mode, sql: body.sql, question: body.question, cron: body.cron, webhookUrl: body.webhookUrl });
      return NextResponse.json(row, { status: 201 });
    }
    if (body.action === 'run') { await runSchedule(body.scheduleId); return NextResponse.json({ ok: true }); }
    return NextResponse.json({ error: 'unknown action' }, { status: 400 });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
  }
}
