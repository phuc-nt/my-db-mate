import { convertToModelMessages, type UIMessage } from 'ai';
import { streamAgentAnswer } from '../../../services/agent-service';
import { getConnection } from '../../../services/connection-service';
import { addMessage } from '../../../services/session-service';
import {
  getSessionInvestigationTarget,
  buildFindingContext,
  INVESTIGATE_FINDING_MAX_SQL,
} from '../../../services/finding-investigation-service';

export const runtime = 'nodejs';
// Investigate mode runs up to 24 steps → allow more wall-clock. On the localhost
// dogfood target this is not host-enforced; an investigation that outruns it is
// best-effort non-resumable (red-team H4, accepted). Raise if deployed behind a
// host that enforces this.
export const maxDuration = 300;

export async function POST(req: Request) {
  const { messages, connectionId, sessionId, mode } = (await req.json()) as {
    messages: UIMessage[];
    connectionId: string;
    sessionId?: string;
    mode?: 'chat' | 'investigate' | 'investigate-deep';
  };

  const conn = await getConnection(connectionId);
  if (!conn) return new Response(JSON.stringify({ error: 'connection not found' }), { status: 404 });

  // Persist the latest user message for session history.
  const last = messages[messages.length - 1];
  if (sessionId && last?.role === 'user') {
    const text = last.parts?.filter((p) => p.type === 'text').map((p) => (p as { text: string }).text).join('') ?? '';
    if (text) await addMessage({ sessionId, role: 'user', content: text });
  }

  // Investigate-from-finding: the target lives ONLY in the session's server-side
  // metadata (written by the investigate-finding route). The finding context is
  // built here — a `findingContext` field in the request body is ignored by
  // design (client text must never reach the system prompt), and every turn of
  // an investigation session is forced into investigate mode with the persisted
  // per-session SQL-step cap.
  const target = sessionId ? await getSessionInvestigationTarget(sessionId) : null;
  const findingContext = target ? await buildFindingContext(connectionId, target) : undefined;

  const result = await streamAgentAnswer({
    connectionId,
    dialect: conn.dialect,
    messages: await convertToModelMessages(messages),
    sessionId,
    mode: target ? 'investigate' : mode === 'investigate' ? 'investigate' : mode === 'investigate-deep' ? 'investigate-deep' : 'chat',
    findingContext,
    maxSqlSteps: target ? INVESTIGATE_FINDING_MAX_SQL : undefined,
  });

  // Persist the finished assistant turn (transcript history + notebook-from-session
  // read the UI parts). consumeStream() drives the model to completion server-side
  // so onFinish still fires if the client disconnects — best-effort under the dev/
  // serverless request lifecycle, which may cancel the background drain on a hard
  // abort; a durable guarantee needs a long-running host / waitUntil (infra, not
  // logic). A connected client (the normal navigate-back-later case) always persists.
  const response = result.toUIMessageStreamResponse({
    onFinish: async ({ responseMessage }) => {
      if (!sessionId) return;
      const text = responseMessage.parts
        ?.filter((p) => p.type === 'text')
        .map((p) => (p as { text: string }).text)
        .join('') ?? '';
      await addMessage({ sessionId, role: 'assistant', content: text, parts: responseMessage.parts });
    },
  });
  result.consumeStream();
  return response;
}
