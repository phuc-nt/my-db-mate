import { convertToModelMessages, type UIMessage } from 'ai';
import { streamAgentAnswer } from '../../../services/agent-service';
import { getConnection } from '../../../services/connection-service';
import { addMessage } from '../../../services/session-service';

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
    mode?: 'chat' | 'investigate';
  };

  const conn = await getConnection(connectionId);
  if (!conn) return new Response(JSON.stringify({ error: 'connection not found' }), { status: 404 });

  // Persist the latest user message for session history.
  const last = messages[messages.length - 1];
  if (sessionId && last?.role === 'user') {
    const text = last.parts?.filter((p) => p.type === 'text').map((p) => (p as { text: string }).text).join('') ?? '';
    if (text) await addMessage({ sessionId, role: 'user', content: text });
  }

  const result = await streamAgentAnswer({
    connectionId,
    dialect: conn.dialect,
    messages: await convertToModelMessages(messages),
    sessionId,
    mode: mode === 'investigate' ? 'investigate' : 'chat',
  });

  return result.toUIMessageStreamResponse({
    onFinish: async ({ responseMessage }) => {
      if (!sessionId) return;
      const text = responseMessage.parts
        ?.filter((p) => p.type === 'text')
        .map((p) => (p as { text: string }).text)
        .join('') ?? '';
      await addMessage({ sessionId, role: 'assistant', content: text, parts: responseMessage.parts });
    },
  });
}
