import { NextResponse } from 'next/server';
import { getSharedDashboard } from '../../../../../services/dashboard-service';

export const runtime = 'nodejs';

/** Public read-only share endpoint. Returns cached results ONLY — no `sql`, no
 *  execution (red-team H1/H2). A viewer with the slug reads the last owner
 *  refresh, nothing more. */
export async function GET(_req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const dash = await getSharedDashboard(slug);
  if (!dash) return NextResponse.json({ error: 'not found' }, { status: 404 });
  return NextResponse.json(dash);
}
