/**
 * Investigate-from-finding entry point.
 *
 * POST: validates an InvestigationTarget (union-validated against this
 * connection's schedules/schema — the client can NEVER supply prompt text) and
 * creates a chat session that carries the target in its metadata. It does NOT
 * start the agent stream: the chat page owns the stream (navigate-first flow),
 * so a navigation away can't abort persistence of the conclusion.
 *
 * GET ?sessionId=: returns the deterministic kickoff message for autostart —
 * survives hard reloads without any client-carried text.
 */
import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { db } from '../../../../../db/client';
import { chatSessions } from '../../../../../db/schema';
import { getConnection } from '../../../../../services/connection-service';
import {
  validateInvestigationTarget,
  getSessionInvestigationTarget,
  investigationTitle,
  kickoffMessage,
  META_TARGET_KEY,
} from '../../../../../services/finding-investigation-service';

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const conn = await getConnection(id);
  if (!conn) return NextResponse.json({ error: 'connection not found' }, { status: 404 });
  let body: unknown;
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'invalid JSON' }, { status: 400 }); }
  try {
    const target = await validateInvestigationTarget(id, body);
    const [session] = await db.insert(chatSessions).values({
      connectionId: id,
      title: investigationTitle(target),
      metadata: { [META_TARGET_KEY]: target },
    }).returning();
    return NextResponse.json({ sessionId: session.id, kickoff: kickoffMessage(target) });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'invalid target' }, { status: 400 });
  }
}

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const sessionId = new URL(req.url).searchParams.get('sessionId');
  if (!sessionId) return NextResponse.json({ error: 'sessionId required' }, { status: 400 });
  const [session] = await db.select().from(chatSessions).where(eq(chatSessions.id, sessionId));
  if (!session || session.connectionId !== id) return NextResponse.json({ error: 'session not found' }, { status: 404 });
  const target = await getSessionInvestigationTarget(sessionId);
  if (!target) return NextResponse.json({ error: 'not an investigation session' }, { status: 404 });
  return NextResponse.json({ kickoff: kickoffMessage(target), title: session.title });
}
