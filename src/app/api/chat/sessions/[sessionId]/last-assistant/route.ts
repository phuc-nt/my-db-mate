import { NextResponse } from 'next/server';
import { deleteLatestAssistantMessage } from '../../../../../../services/session-service';

export const runtime = 'nodejs';

/** DELETE → remove the most recent assistant message in a session. The chat
 *  interrupt's Discard action calls this when the server already persisted a
 *  completed turn the user threw away (investigate mode). */
export async function DELETE(_req: Request, { params }: { params: Promise<{ sessionId: string }> }) {
  const { sessionId } = await params;
  const deletedId = await deleteLatestAssistantMessage(sessionId);
  return NextResponse.json({ ok: true, deletedId });
}
