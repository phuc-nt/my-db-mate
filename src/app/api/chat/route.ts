import { convertToModelMessages, createUIMessageStream, createUIMessageStreamResponse, type UIMessage } from 'ai';
import { streamAgentAnswer } from '../../../services/agent-service';
import { getConnection } from '../../../services/connection-service';
import { addMessage, wasTurnDiscarded } from '../../../services/session-service';
import {
  getSessionInvestigationTarget,
  buildFindingContext,
  INVESTIGATE_FINDING_MAX_SQL,
} from '../../../services/finding-investigation-service';
import { getSchemaSummary } from '../../../services/schema-sync-service';
import {
  decomposeQuestion,
  splitBudget,
  runSubInvestigations,
  synthesizeSections,
  hasSurvivors,
} from '../../../services/sub-investigation-service';
import type { Dialect } from '../../../services/connection-providers/provider-interface';

/** Parent investigate caps (mirror agent-service constants; envs override there). */
const PARENT_SQL = { investigate: Number(process.env.INVESTIGATE_MAX_SQL ?? 30), 'investigate-deep': Number(process.env.INVESTIGATE_DEEP_MAX_SQL ?? 60) };
const PARENT_STEPS = { investigate: Number(process.env.INVESTIGATE_MAX_STEPS ?? 24), 'investigate-deep': Number(process.env.INVESTIGATE_DEEP_MAX_STEPS ?? 48) };

/** The latest user turn's plain text (mirrors agent-service extraction). */
function latestUserText(messages: UIMessage[]): string {
  const last = [...messages].reverse().find((m) => m.role === 'user');
  return last?.parts?.filter((p) => p.type === 'text').map((p) => (p as { text: string }).text).join(' ') ?? '';
}

/** Drop a merged stream's own message-boundary chunks so its content joins the
 *  CURRENT assistant message instead of opening a new one (A4: the synthesis is
 *  the same turn as the sub-investigation cards). */
function stripMessageBoundaries<T extends { type?: string }>(stream: ReadableStream<T>): ReadableStream<T> {
  return stream.pipeThrough(
    new TransformStream<T, T>({
      transform(chunk, controller) {
        if (chunk?.type === 'start' || chunk?.type === 'finish') return;
        controller.enqueue(chunk);
      },
    }),
  );
}

/** A compact digest of the last few turns so a breadth follow-up can resolve its
 *  references at decompose time (red-team H3). */
function historyDigest(messages: UIMessage[]): string {
  return messages
    .slice(-6)
    .map((m) => {
      const t = m.parts?.filter((p) => p.type === 'text').map((p) => (p as { text: string }).text).join(' ') ?? '';
      return t ? `${m.role}: ${t.slice(0, 300)}` : '';
    })
    .filter(Boolean)
    .join('\n');
}

export const runtime = 'nodejs';
// Investigate mode runs up to 24 steps → allow more wall-clock. On the localhost
// dogfood target this is not host-enforced; an investigation that outruns it is
// best-effort non-resumable (red-team H4, accepted). Raise if deployed behind a
// host that enforces this.
export const maxDuration = 300;

export async function POST(req: Request) {
  const { messages, connectionId, sessionId, mode, highStakes } = (await req.json()) as {
    messages: UIMessage[];
    connectionId: string;
    sessionId?: string;
    mode?: 'chat' | 'investigate' | 'investigate-deep';
    highStakes?: boolean;
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

  const resolvedMode = target ? 'investigate' : mode === 'investigate' ? 'investigate' : mode === 'investigate-deep' ? 'investigate-deep' : 'chat';
  const isInvestigate = resolvedMode !== 'chat';
  const turnStartIso = new Date().toISOString();

  // A4: breadth decomposition — investigate mode only, NEVER on the finding path
  // (findingCap keeps its strict single-loop per-session cap) and never in chat.
  if (isInvestigate && !target) {
    const question = latestUserText(messages);
    const schema = await getSchemaSummary(connectionId);
    const decomposed = question
      ? await decomposeQuestion(question, historyDigest(messages), schema, conn.dialect as Dialect)
      : { decompose: false as const };

    if (decomposed.decompose) {
      const parentSql = PARENT_SQL[resolvedMode as 'investigate' | 'investigate-deep'];
      const parentSteps = PARENT_STEPS[resolvedMode as 'investigate' | 'investigate-deep'];
      const budget = splitBudget(parentSql, parentSteps, decomposed.subQuestions.length);
      const subs = decomposed.subQuestions.slice(0, budget.n);

      const stream = createUIMessageStream({
        execute: async ({ writer }) => {
          const snapshots = await runSubInvestigations({
            connectionId, dialect: conn.dialect as Dialect, subs,
            budget: { maxSql: budget.maxSql, maxSteps: budget.maxSteps }, writer, sessionId,
          });
          if (hasSurvivors(snapshots)) {
            const synth = await synthesizeSections(question, snapshots, conn.dialect);
            // Merge WITHOUT the synthesis stream's own message-boundary chunks: a
            // nested `start`/`finish` makes the client open a SECOND assistant
            // bubble, so the sub-cards and the synthesis would split across two
            // messages (and the cards render twice). Keep it one turn.
            writer.merge(stripMessageBoundaries(synth.toUIMessageStream()));
          } else {
            // red-team M2: never hand the model empty evidence to narrate.
            const reasons = snapshots.map((s) => `${s.title}: ${s.error ?? s.status}`).join('; ');
            writer.write({ type: 'text-start', id: 'fail' });
            writer.write({ type: 'text-delta', id: 'fail', delta: `All ${subs.length} sub-investigations failed to produce a result (${reasons}). Please retry or narrow the question.` });
            writer.write({ type: 'text-end', id: 'fail' });
          }
        },
        onError: (e) => (e instanceof Error ? e.message : 'sub-investigation error'),
        onFinish: async ({ responseMessage }) => {
          if (!sessionId) return;
          if (await wasTurnDiscarded(sessionId, turnStartIso)) return; // A4 H4
          const text = responseMessage.parts?.filter((p) => p.type === 'text').map((p) => (p as { text: string }).text).join('') ?? '';
          await addMessage({ sessionId, role: 'assistant', content: text, parts: responseMessage.parts });
        },
      });
      return createUIMessageStreamResponse({ stream });
    }
    // decompose:false → fall through to the standard single-loop investigate path.
  }

  const result = await streamAgentAnswer({
    connectionId,
    dialect: conn.dialect,
    messages: await convertToModelMessages(messages),
    sessionId,
    mode: resolvedMode,
    findingContext,
    maxSqlSteps: target ? INVESTIGATE_FINDING_MAX_SQL : undefined,
    // Wiring the request signal makes a client Stop actually halt the server-side
    // agent — no more tokens/queries/budget spent after the user stops. Investigate
    // mode deliberately does NOT get this: its conclusion must survive the user
    // navigating away, so it keeps draining via consumeStream() below.
    abortSignal: isInvestigate ? undefined : req.signal,
    // High-stakes candidate voting is chat-only: force-false in investigate /
    // investigate-from-finding so a `highStakes:true` body can't trigger it there.
    highStakes: !!highStakes && resolvedMode === 'chat',
  });

  // Persist the finished assistant turn (transcript history + notebook-from-session
  // read the UI parts). In investigate mode consumeStream() drives the model to
  // completion server-side so onFinish still fires if the client disconnects (the
  // navigate-back-later case). In chat mode we do NOT drain: a Stop propagates
  // through abortSignal and truly halts the run — the trade-off is that a chat turn
  // interrupted mid-flight is not persisted (cheap to re-ask), which is intended.
  const response = result.toUIMessageStreamResponse({
    onFinish: async ({ responseMessage }) => {
      if (!sessionId) return;
      // A4 H4: an investigate turn drains server-side; if the user discarded it
      // mid-run, skip persisting so it doesn't resurrect as a zombie.
      if (isInvestigate && (await wasTurnDiscarded(sessionId, turnStartIso))) return;
      const text = responseMessage.parts
        ?.filter((p) => p.type === 'text')
        .map((p) => (p as { text: string }).text)
        .join('') ?? '';
      await addMessage({ sessionId, role: 'assistant', content: text, parts: responseMessage.parts });
    },
  });
  if (isInvestigate) result.consumeStream();
  return response;
}
