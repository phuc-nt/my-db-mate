import { NextResponse } from 'next/server';
import { discardLatestTurn } from '../../../../../../services/session-service';

export const runtime = 'nodejs';

/** POST → discard the session's latest turn, whatever state it is in. The server
 *  decides atomically: a still-draining turn gets a tombstone (its eventual
 *  persist skips); an already-persisted turn has its answer rows (assistant rows
 *  newer than the final user message) deleted. Timestamps are SERVER-clock only —
 *  a browser clock minutes ahead once wrote future tombstones that swallowed
 *  legitimate later turns, and a client-side "delete latest assistant" once
 *  erased the PREVIOUS turn's answer while the current one was still draining. */
export async function POST(_req: Request, { params }: { params: Promise<{ sessionId: string }> }) {
  const { sessionId } = await params;
  const result = await discardLatestTurn(sessionId);
  return NextResponse.json({ ok: true, ...result });
}
