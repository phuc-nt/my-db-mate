import { NextResponse } from 'next/server';
import { mineSession } from '../../../../../services/knowledge-mining-service';

export const runtime = 'nodejs';
export const maxDuration = 120;

/** POST → mine a session into pending Knowledge Inbox suggestions. */
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const created = await mineSession(id);
    return NextResponse.json({ created });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
  }
}
