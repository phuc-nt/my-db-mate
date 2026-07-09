import { NextResponse } from 'next/server';
import { getSharedReport } from '../../../../../services/report-service';

export const runtime = 'nodejs';

/** Public read-only share endpoint for a report. Returns the latest version's
 *  markdown + snapshot only — no source SQL, no execution (like the dashboard
 *  share surface). */
export async function GET(_req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const r = await getSharedReport(slug);
  if (!r) return NextResponse.json({ error: 'not found' }, { status: 404 });
  return NextResponse.json(r);
}
