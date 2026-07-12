import { NextResponse } from 'next/server';
import { createMetric, listMetrics } from '../../../../../services/metric-service';

export const runtime = 'nodejs';

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return NextResponse.json(await listMetrics(id));
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await req.json().catch(() => ({}));
  if (typeof body.name !== 'string' || typeof body.sql !== 'string') {
    return NextResponse.json({ error: 'name and sql required' }, { status: 400 });
  }
  const r = await createMetric(id, body);
  if ('error' in r) return NextResponse.json({ error: r.error }, { status: 400 });
  return NextResponse.json(r.metric, { status: 201 });
}
