/** Chat session persistence: sessions, messages, and the query-run audit view. */
import { and, desc, eq, sql } from 'drizzle-orm';
import { db } from '../db/client';
import { chatSessions, chatMessages, queryRuns } from '../db/schema';

export async function createSession(connectionId: string, title?: string) {
  const [row] = await db
    .insert(chatSessions)
    .values({ connectionId, title: title ?? null })
    .returning();
  return row;
}

export async function listSessions(connectionId?: string) {
  const q = db.select().from(chatSessions).orderBy(desc(chatSessions.createdAt));
  if (connectionId) return q.where(eq(chatSessions.connectionId, connectionId));
  return q;
}

export async function getMessages(sessionId: string) {
  return db
    .select()
    .from(chatMessages)
    .where(eq(chatMessages.sessionId, sessionId))
    .orderBy(chatMessages.createdAt);
}

export async function addMessage(params: {
  sessionId: string;
  role: 'user' | 'assistant';
  content: string;
  parts?: unknown[];
}) {
  const [row] = await db
    .insert(chatMessages)
    .values({
      sessionId: params.sessionId,
      role: params.role,
      content: params.content,
      parts: params.parts ?? null,
    })
    .returning();
  return row;
}

/** Metadata key for the Discard-mid-run tombstone (A4 H4). */
const META_DISCARD_AFTER_KEY = 'discardAfter';

/** Mark that the user discarded the in-flight turn (investigate/breadth mode
 *  keeps draining server-side and would otherwise persist a turn the user threw
 *  away — a zombie). The persist path checks this: if a tombstone at/after the
 *  turn's start exists, it skips persisting. Stores an ISO timestamp. */
export async function setDiscardTombstone(sessionId: string, atIso: string): Promise<void> {
  await db
    .update(chatSessions)
    .set({ metadata: sql`jsonb_set(coalesce(${chatSessions.metadata}, '{}'::jsonb), ${`{${META_DISCARD_AFTER_KEY}}`}::text[], ${JSON.stringify(atIso)}::jsonb)` })
    .where(eq(chatSessions.id, sessionId));
}

/** Whether the current turn (started at `turnStartIso`) was discarded while in
 *  flight — true when a tombstone timestamp ≥ the turn's start exists. Used by
 *  the persist path to skip a discarded turn (A4 H4). */
export async function wasTurnDiscarded(sessionId: string, turnStartIso: string): Promise<boolean> {
  const [row] = await db.select({ metadata: chatSessions.metadata }).from(chatSessions).where(eq(chatSessions.id, sessionId));
  const at = (row?.metadata as Record<string, unknown> | null)?.[META_DISCARD_AFTER_KEY];
  return typeof at === 'string' && at >= turnStartIso;
}

/** Delete the most recent assistant message in a session — used by the chat
 *  interrupt's Discard action when the server already persisted a (completed)
 *  turn the user chose to throw away (investigate mode). Single-user, no
 *  concurrent turns, so "latest assistant" unambiguously targets that turn.
 *  Returns the deleted row's id, or null if there was none. */
export async function deleteLatestAssistantMessage(sessionId: string): Promise<string | null> {
  const [latest] = await db
    .select({ id: chatMessages.id })
    .from(chatMessages)
    .where(and(eq(chatMessages.sessionId, sessionId), eq(chatMessages.role, 'assistant')))
    .orderBy(desc(chatMessages.createdAt))
    .limit(1);
  if (!latest) return null;
  await db.delete(chatMessages).where(eq(chatMessages.id, latest.id));
  return latest.id;
}

/** Audit trail for a session (or a connection). */
export async function getQueryRuns(params: { sessionId?: string; connectionId?: string }) {
  if (params.sessionId) {
    return db.select().from(queryRuns).where(eq(queryRuns.sessionId, params.sessionId)).orderBy(desc(queryRuns.createdAt));
  }
  if (params.connectionId) {
    return db.select().from(queryRuns).where(eq(queryRuns.connectionId, params.connectionId)).orderBy(desc(queryRuns.createdAt));
  }
  return db.select().from(queryRuns).orderBy(desc(queryRuns.createdAt)).limit(200);
}
