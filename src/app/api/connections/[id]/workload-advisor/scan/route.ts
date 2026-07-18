/**
 * Workload advisor scan (on-demand). Collects the engine's workload stats and
 * runs the deterministic advisor rules. Read-only: the collector uses bounded
 * app-internal reads over system views, and every suggestion is copy-only DDL —
 * no code path here executes a CREATE/DROP.
 */
import { NextResponse } from 'next/server';
import { getConnection, getProvider } from '../../../../../../services/connection-service';
import { collectWorkloadStats } from '../../../../../../services/workload-advisor/workload-stats-collector';
import { adviseWorkload } from '../../../../../../services/workload-advisor/advisor-rules';

export const runtime = 'nodejs';
// System-view reads + a handful of bounded EXPLAIN calls run inline.
export const maxDuration = 120;

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const conn = await getConnection(id);
  if (!conn) return NextResponse.json({ error: 'connection not found' }, { status: 404 });

  const provider = await getProvider(id);
  try {
    const stats = await collectWorkloadStats(provider);
    if (!stats.availability.available) {
      return NextResponse.json({ available: false, hint: stats.availability.hint, findings: [] });
    }
    const { findings, unparsedCount } = await adviseWorkload(stats, provider);
    return NextResponse.json({
      available: true,
      hint: stats.availability.hint,
      hotspotCount: stats.hotspots.length,
      unparsedCount,
      findings,
    });
  } finally {
    await provider.close();
  }
}
