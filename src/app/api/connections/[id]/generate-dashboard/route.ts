import { NextResponse } from 'next/server';
import { generateDashboardProposal } from '../../../../../services/dashboard-generation-service';

export const runtime = 'nodejs';

/** POST { prompt, existingWidgets? } → a dashboard proposal (widgets probed, not
 *  yet created). The preview UI accepts a subset via /api/dashboards/generate-accept. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await req.json().catch(() => ({}));
  const prompt = typeof body.prompt === 'string' ? body.prompt.slice(0, 2000) : '';
  if (!prompt.trim()) return NextResponse.json({ ok: false, error: 'prompt required' }, { status: 400 });

  const existingWidgets = Array.isArray(body.existingWidgets)
    ? body.existingWidgets
        .filter((w: unknown) => w && typeof w === 'object' && typeof (w as { title?: unknown }).title === 'string' && typeof (w as { sql?: unknown }).sql === 'string')
        .slice(0, 30)
    : undefined;

  const result = await generateDashboardProposal({ connectionId: id, prompt, existingWidgets });
  return NextResponse.json(result, { status: result.ok ? 200 : 200 });
}
