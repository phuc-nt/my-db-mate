import { NextResponse } from 'next/server';
import { profileConnection, getDataHealth } from '../../../../../services/data-quality-service';

export const runtime = 'nodejs';
// Profiling runs INLINE (cost-capped) — no background runtime exists in a route.
export const maxDuration = 300;

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return NextResponse.json(await getDataHealth(id));
}

/** Manually trigger a data-quality profile (inline). */
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const result = await profileConnection(id);
  return NextResponse.json(result);
}
