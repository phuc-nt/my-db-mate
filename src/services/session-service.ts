/** Chat session persistence: sessions, messages, and the query-run audit view. */
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
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

/** The current tombstone timestamp, if any — callers that intend to consume it
 *  must capture this value and pass it to `clearDiscardTombstone` so a NEWER
 *  tombstone (a second discard racing this drain) is never stolen. */
export async function getDiscardTombstone(sessionId: string): Promise<string | null> {
  const [row] = await db.select({ metadata: chatSessions.metadata }).from(chatSessions).where(eq(chatSessions.id, sessionId));
  const at = (row?.metadata as Record<string, unknown> | null)?.[META_DISCARD_AFTER_KEY];
  return typeof at === 'string' ? at : null;
}

/** Consume the tombstone AFTER its skip fired — the only race-free point to
 *  clear it. Clearing on a new POST instead would let a still-draining discarded
 *  turn outlive its tombstone and persist after all (the A4 zombie, reborn).
 *  Compare-and-delete: only removes the exact value the skip observed, so turn
 *  A's late drain can't consume the tombstone stamped for turn B's discard. */
export async function clearDiscardTombstone(sessionId: string, observedAt: string): Promise<void> {
  await db
    .update(chatSessions)
    .set({ metadata: sql`coalesce(${chatSessions.metadata}, '{}'::jsonb) - ${META_DISCARD_AFTER_KEY}` })
    .where(and(eq(chatSessions.id, sessionId), sql`coalesce(${chatSessions.metadata}, '{}'::jsonb)->>${META_DISCARD_AFTER_KEY} = ${observedAt}`));
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

/**
 * Discard the LATEST TURN, deciding server-side what that means — the client
 * cannot know whether the turn it is discarding was already persisted:
 * - not yet persisted (server still draining): the tombstone makes the eventual
 *   persist skip; nothing is deleted — "delete latest assistant" here would hit
 *   the PREVIOUS turn's answer (full-UAT-caught bug: discarding a running
 *   breadth turn silently erased the prior investigation's result);
 * - already persisted: its answer is exactly the assistant rows newer than the
 *   final user message — delete those, never anything older.
 * Both cases stamp the tombstone (server clock), so a drain that races this
 * call is covered either way. Returns what happened for observability.
 */
export async function discardLatestTurn(sessionId: string): Promise<{ deleted: number; tombstoned: boolean }> {
  await setDiscardTombstone(sessionId, new Date().toISOString());
  // Positional, not timestamp-compared: take the ordered transcript and delete
  // only assistant rows AFTER the final user row. A raw `createdAt >` compare
  // mis-fires when rows share a timestamp; position can never reach anything
  // at-or-before the last user message, so an earlier turn's answer is safe by
  // construction.
  const msgs = await getMessages(sessionId);
  let lastUserIdx = -1;
  msgs.forEach((m, i) => { if (m.role === 'user') lastUserIdx = i; });
  if (lastUserIdx < 0) return { deleted: 0, tombstoned: true };
  const ids = msgs.slice(lastUserIdx + 1).filter((m) => m.role === 'assistant').map((m) => m.id);
  if (ids.length === 0) return { deleted: 0, tombstoned: true };
  await db.delete(chatMessages).where(inArray(chatMessages.id, ids));
  return { deleted: ids.length, tombstoned: true };
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
