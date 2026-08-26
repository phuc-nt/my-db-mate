import { NextResponse } from 'next/server';
import { getMessages } from '@/core/app-state/session-service';
import { getSessionInvestigationTarget } from '@/modules/chat-agent';
import { dbRowsToUiMessages, type ChatMessageRow } from '@/modules/chat-agent';

export const runtime = 'nodejs';

/** GET → the session's persisted transcript as renderable UIMessages, ready for
 *  useChat setMessages (rehydration). The mapper synthesizes text parts for rows
 *  without parts (user rows, pre-A3 assistant rows) and prunes dangling tool
 *  parts that would otherwise poison the next send (plan red-team C1).
 *  `investigation` marks a target-carrying session so the client opens it
 *  read-only (server forces investigate mode + step cap on its turns — H4). */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [rows, target] = await Promise.all([getMessages(id), getSessionInvestigationTarget(id)]);
  return NextResponse.json({
    messages: dbRowsToUiMessages(rows as unknown as ChatMessageRow[]),
    investigation: !!target,
  });
}
