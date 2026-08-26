import { NextResponse } from 'next/server';
import { deleteMetric, getMetric, updateMetric } from '@/modules/metrics';
import { requireModule } from '@/core/require-module';

export const runtime = 'nodejs';

/** Guard every per-metric verb against cross-connection ID guessing. */
async function owned(connectionId: string, metricId: string) {
  const m = await getMetric(metricId);
  return m && m.connectionId === connectionId ? m : null;
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string; metricId: string }> }) {
  const disabled = requireModule('metrics');
  if (disabled) return disabled;
  const { id, metricId } = await params;
  if (!(await owned(id, metricId))) return NextResponse.json({ error: 'not found' }, { status: 404 });
  const body = await req.json().catch(() => ({}));
  // connectionId is immutable — silently ignore any attempt to move the metric.
  delete body.connectionId;
  const r = await updateMetric(metricId, body);
  if ('error' in r) return NextResponse.json({ error: r.error }, { status: 400 });
  return NextResponse.json(r.metric);
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string; metricId: string }> }) {
  const disabled = requireModule('metrics');
  if (disabled) return disabled;
  const { id, metricId } = await params;
  if (!(await owned(id, metricId))) return NextResponse.json({ error: 'not found' }, { status: 404 });
  await deleteMetric(metricId);
  return NextResponse.json({ ok: true });
}
