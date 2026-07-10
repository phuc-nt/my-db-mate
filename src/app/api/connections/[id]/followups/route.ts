import { NextResponse } from 'next/server';
import { generateFollowups } from '../../../../../services/followup-service';

export const runtime = 'nodejs';
export const maxDuration = 30;

/** POST → 2-3 follow-up question suggestions. Body: { question, columns? }. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await req.json().catch(() => ({}));
  const question = typeof body.question === 'string' ? body.question : '';
  const columns = Array.isArray(body.columns) ? body.columns.map(String) : undefined;
  if (!question) return NextResponse.json({ followups: [] });
  try {
    const followups = await generateFollowups(id, question, columns);
    return NextResponse.json({ followups });
  } catch (e) {
    // A follow-up failure is non-fatal — return none rather than erroring the UI.
    console.error('[followups]', e instanceof Error ? e.message : e);
    return NextResponse.json({ followups: [] });
  }
}
