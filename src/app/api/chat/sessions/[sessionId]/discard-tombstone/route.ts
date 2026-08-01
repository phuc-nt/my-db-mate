import { NextResponse } from 'next/server';
import { setDiscardTombstone } from '../../../../../../services/session-service';

export const runtime = 'nodejs';

/** POST → mark the in-flight turn as discarded (A4 H4). The server keeps draining
 *  an investigate/breadth turn after the client leaves; without this, that turn
 *  would persist on finish even though the user discarded it (a zombie), and the
 *  immediate DELETE-last-assistant would wrongly remove the PREVIOUS turn (not yet
 *  overwritten). The persist path checks this tombstone and skips the discarded
 *  turn. Body: { at: ISO string } — the moment the current turn started. */
export async function POST(_req: Request, { params }: { params: Promise<{ sessionId: string }> }) {
  const { sessionId } = await params;
  // SERVER clock only — the tombstone is compared against server-stamped turn
  // starts, and a browser clock minutes ahead would write a future tombstone
  // that silently swallows legitimate later turns (review fix). Any client-sent
  // timestamp is deliberately ignored.
  await setDiscardTombstone(sessionId, new Date().toISOString());
  return NextResponse.json({ ok: true });
}
