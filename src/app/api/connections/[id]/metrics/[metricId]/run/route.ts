import { NextResponse } from 'next/server';
import { getMetric, runMetric } from '@/modules/metrics';
import { requireModule } from '@/core/require-module';

export const runtime = 'nodejs';

export async function GET(_req: Request, { params }: { params: Promise<{ id: string; metricId: string }> }) {
  const disabled = requireModule('metrics');
  if (disabled) return disabled;
  const { id, metricId } = await params;
  const m = await getMetric(metricId);
  if (!m || m.connectionId !== id) return NextResponse.json({ error: 'not found' }, { status: 404 });
  const r = await runMetric(metricId);
  if (r.error) return NextResponse.json({ error: r.error }, { status: 400 });
  return NextResponse.json(r.run);
}
