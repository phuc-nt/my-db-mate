/** Chat session persistence: sessions, messages, and the query-run audit view. */
import { desc, eq } from 'drizzle-orm';
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
