import { convertToModelMessages, createUIMessageStream, createUIMessageStreamResponse, type UIMessage } from 'ai';
import {
  streamAgentAnswer,
  MAX_SQL_PER_INVESTIGATION,
  MAX_SQL_DEEP,
  MAX_STEPS_INVESTIGATE,
  MAX_STEPS_INVESTIGATE_DEEP,
} from '../../../services/agent-service';
import { getConnection } from '@/core/connections/connection-service';
import { addMessage, getDiscardTombstone, clearDiscardTombstone } from '../../../services/session-service';
import {
  getSessionInvestigationTarget,
  buildFindingContext,
  INVESTIGATE_FINDING_MAX_SQL,
} from '../../../services/finding-investigation-service';
import { getSchemaSummary } from '@/core/schema/schema-sync-service';
import { LLM_NOT_CONFIGURED } from '../../../services/llm-service';
import {
  decomposeQuestion,
  splitBudget,
  runSubInvestigations,
  synthesizeSections,
  hasSurvivors,
} from '../../../services/sub-investigation-service';
import type { Dialect } from '@/core/connections/providers/provider-interface';
import { SUBQ_PART_TYPE } from '../../../lib/sub-investigation-types';
import { SNAPSHOT_QUERY_CAP } from '../../../services/sub-investigation-service';

/** Parent investigate caps — imported from agent-service, which OWNS them. The
 *  budget split must divide the real cap: a local copy would silently drift if
 *  the owner's value changed, letting the sub-caps exceed the parent. */
/** How many trailing UIMessages the MODEL re-reads per send (H5). Rehydrated
 *  sessions can carry very heavy transcripts; the UI shows everything, the model
 *  only needs recent context. Env-overridable for tuning. */
const MODEL_HISTORY_WINDOW = (() => { const n = Number(process.env.CHAT_MODEL_HISTORY_WINDOW ?? 20); return Number.isFinite(n) && n > 0 ? n : 20; })();

const PARENT_SQL = { investigate: MAX_SQL_PER_INVESTIGATION, 'investigate-deep': MAX_SQL_DEEP };
const PARENT_STEPS = { investigate: MAX_STEPS_INVESTIGATE, 'investigate-deep': MAX_STEPS_INVESTIGATE_DEEP };

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
          let synthesisText = '';
          if (hasSurvivors(snapshots)) {
            const synth = await synthesizeSections(question, snapshots, conn.dialect);
            // Merge WITHOUT the synthesis stream's own message-boundary chunks: a
            // nested `start`/`finish` makes the client open a SECOND assistant
            // bubble, so the sub-cards and the synthesis would split across two
            // messages (and the cards render twice). Keep it one turn.
            writer.merge(stripMessageBoundaries(synth.toUIMessageStream()));
            // Await the full text so persistence below sees the FINISHED turn.
            synthesisText = await synth.text;
          } else {
            // red-team M2: never hand the model empty evidence to narrate.
            const reasons = snapshots.map((s) => `${s.title}: ${s.error ?? s.status}`).join('; ');
            synthesisText = `All ${subs.length} sub-investigations failed to produce a result (${reasons}). Please retry or narrow the question.`;
            writer.write({ type: 'text-start', id: 'fail' });
            writer.write({ type: 'text-delta', id: 'fail', delta: synthesisText });
            writer.write({ type: 'text-end', id: 'fail' });
          }
          // Persist HERE, not in onFinish: onFinish fires when the response stream
          // closes, which a client disconnect does immediately — it would save a
          // half-finished turn (sub-cards frozen at "running", no synthesis) and
          // silently lose the work this mode exists to protect. Persisting after
          // the orchestration completes is what makes a breadth investigation
          // survive the user navigating away.
          // Consume-the-exact-tombstone: capture the observed value so a NEWER
          // tombstone (turn B discarded while turn A still drains) is never
          // stolen by A's late finish (review Medium #2).
          const tomb = sessionId ? await getDiscardTombstone(sessionId) : null;
          if (sessionId && !(tomb && tomb >= turnStartIso)) {
            const parts = [
              // Persist the same query window the wire showed (shared cap) — the
              // stored row must not silently hold more than the UI ever did.
              ...snapshots.map((s) => ({ type: SUBQ_PART_TYPE, id: s.id, data: { ...s, queries: s.queries.slice(-SNAPSHOT_QUERY_CAP) } })),
              ...(synthesisText ? [{ type: 'text', text: synthesisText }] : []),
            ];
            await addMessage({ sessionId, role: 'assistant', content: synthesisText, parts });
          } else if (sessionId && tomb) {
            // The tombstone did its one job (this skip) — consume exactly it.
            // Consuming HERE is the only race-free point: clearing on a new POST
            // would let a still-draining discarded turn outlive its tombstone and
            // persist after all (A4 zombie).
            await clearDiscardTombstone(sessionId, tomb);
          }
        },
        // NO onFinish persistence here — see the comment above: it fires on stream
        // close (i.e. immediately on a client disconnect) and would save a partial
        // turn. The execute closure persists the completed one.
        onError: (e) => (e instanceof Error ? e.message : 'sub-investigation error'),
      });
      return createUIMessageStreamResponse({ stream });
    }
    // decompose:false → fall through to the standard single-loop investigate path.
  }

  // `getModel()` throws before any streaming starts when no usable key exists.
  // Letting that surface as a bare 500 is what made a fresh install feel broken
  // rather than unconfigured, so it becomes a typed payload the UI can explain.
  // Only THIS code is special-cased — every other failure keeps its old path.
  let result: Awaited<ReturnType<typeof streamAgentAnswer>>;
  try {
    result = await streamAgentAnswer({
      connectionId,
      dialect: conn.dialect,
      // Model-history window (H5): a rehydrated session ships its whole transcript
      // (30-query investigations, vote payloads) — cap what the model re-reads per
      // send. The UI keeps the full transcript; only the model payload is windowed.
      messages: await convertToModelMessages(messages.slice(-MODEL_HISTORY_WINDOW)),
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
      // AUTO high-stakes (governed-metric questions verify unasked) is opted in by
      // THIS interactive route only — headless callers (MCP/schedule/eval) must
      // never silently gain the extra cost (red-team H1).
      allowAutoHighStakes: true,
    });
  } catch (e) {
    if ((e as { code?: string })?.code === LLM_NOT_CONFIGURED) {
      return new Response(
        JSON.stringify({ error: (e as Error).message, code: LLM_NOT_CONFIGURED }),
        { status: 503, headers: { 'content-type': 'application/json' } },
      );
    }
    throw e;
  }

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
      if (isInvestigate) {
        const tomb = await getDiscardTombstone(sessionId);
        if (tomb && tomb >= turnStartIso) {
          await clearDiscardTombstone(sessionId, tomb); // consume exactly what we observed
          return;
        }
      }
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
