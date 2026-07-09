import { NextResponse } from 'next/server';
import { listSuggestions, acceptSuggestion, rejectSuggestion } from '../../../../../services/knowledge-mining-service';

export const runtime = 'nodejs';

/** GET → pending Knowledge Inbox suggestions. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return NextResponse.json(await listSuggestions(id));
}

/** POST → { action:'accept'|'reject', suggestionId, payload? }. */
export async function POST(req: Request) {
  const body = await req.json();
  try {
    if (body.action === 'accept') await acceptSuggestion(body.suggestionId, body.payload);
    else if (body.action === 'reject') await rejectSuggestion(body.suggestionId);
    else return NextResponse.json({ error: 'unknown action' }, { status: 400 });
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
  }
}
