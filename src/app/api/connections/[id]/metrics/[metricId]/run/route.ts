import { NextResponse } from 'next/server';
import { getMetric, runMetric } from '../../../../../../../services/metric-service';

export const runtime = 'nodejs';

export async function GET(_req: Request, { params }: { params: Promise<{ id: string; metricId: string }> }) {
  const { id, metricId } = await params;
  const m = await getMetric(metricId);
  if (!m || m.connectionId !== id) return NextResponse.json({ error: 'not found' }, { status: 404 });
  const r = await runMetric(metricId);
  if (r.error) return NextResponse.json({ error: r.error }, { status: 400 });
  return NextResponse.json(r.run);
}
