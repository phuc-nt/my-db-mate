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
  // Drain the stream server-side so onFinish (assistant-message persistence) runs
  // even if the client disconnects mid-stream — e.g. the user navigates away from
  // an investigation before it concludes. Without this the conclusion (and the
  // BigQuery spend behind it) is lost when the browser fetch aborts.
  result.consumeStream();
  return response;
}
