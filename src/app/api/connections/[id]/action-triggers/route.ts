/**
 * Action-triggers CRUD + test-fire. Webhook-out only — creating a trigger can
 * never cause a write to a source database (the service imports no execution API).
 */
import { NextResponse } from 'next/server';
import { getConnection } from '../../../../../services/connection-service';
import {
  listTriggers, listFires, createTrigger, updateTrigger, deleteTrigger, testFire,
} from '../../../../../services/action-trigger-service';

export const runtime = 'nodejs';

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const triggerId = new URL(req.url).searchParams.get('fires');
  if (triggerId) return NextResponse.json(await listFires(triggerId));
  return NextResponse.json(await listTriggers(id));
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const conn = await getConnection(id);
  if (!conn) return NextResponse.json({ error: 'connection not found' }, { status: 404 });
  const body = await req.json().catch(() => ({}));
  try {
    if (body.action === 'test' && typeof body.triggerId === 'string') {
      return NextResponse.json(await testFire(body.triggerId, conn.name));
    }
    const row = await createTrigger({
      connectionId: id, name: body.name, condition: body.condition,
      webhookUrl: body.webhookUrl, payloadTemplate: body.payloadTemplate, rateLimitPerHour: body.rateLimitPerHour,
    });
    return NextResponse.json(row);
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'create failed' }, { status: 400 });
  }
}

export async function PATCH(req: Request) {
  const body = await req.json().catch(() => ({}));
  if (typeof body.triggerId !== 'string') return NextResponse.json({ error: 'triggerId required' }, { status: 400 });
  try {
    const row = await updateTrigger(body.triggerId, body);
    return NextResponse.json(row);
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'update failed' }, { status: 400 });
  }
}

export async function DELETE(req: Request) {
  const body = await req.json().catch(() => ({}));
  if (typeof body.triggerId !== 'string') return NextResponse.json({ error: 'triggerId required' }, { status: 400 });
  await deleteTrigger(body.triggerId);
  return NextResponse.json({ ok: true });
}
