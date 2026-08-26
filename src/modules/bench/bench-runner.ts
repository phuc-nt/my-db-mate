/**
 * The benchmark loop: one BIRD question in, one scored record out.
 *
 * It drives the SAME agent entry point the chat route uses (`streamAgentAnswer`
 * via `runAgentAnswer`) against a normal SQLite connection through the normal
 * executor. That is the point — a benchmark that calls a special "benchmark
 * mode" of the model measures the benchmark mode, not the product.
 *
 * Three rules the loop must not bend, because bending any of them would inflate
 * the number:
 *
 *   1. The safety and scope gates stay ON. A query the gate refuses scores
 *      `gate_blocked`, which counts as wrong. A gate the benchmark can switch
 *      off is not a gate, and "our EX with safety disabled" is a number about
 *      software we do not ship.
 *   2. Gold SQL is never edited, and never shown to the agent.
 *   3. Every question gets a verdict. A question that crashes the agent is
 *      `agent_error`, not a skipped row — dropping failures is how a harness
 *      quietly reports the accuracy of the subset that happened to work.
 */
import { getConnection, getProvider } from '@/core/connections/connection-service';
import { executeQuery } from '@/core/execution/query-executor-service';
import { runAgentAnswer, MAX_STEPS_CHAT } from '@/modules/chat-agent';
import type { BenchQuestion } from './bench-dataset';
import { executionMatch, extractFinalSql, type Verdict } from './bench-scorer';
import { costUsd, type TokenUsage } from './bench-pricing';

/** Wall-clock ceiling for one question's agent loop. BIRD's own scorer uses a
 *  30 s per-QUERY timeout; an agent loop legitimately takes longer because it
 *  explores the schema first, so this is the loop budget, not the query one. */
export const QUESTION_TIMEOUT_MS = 180_000;

/** Extra attempts for a question whose failure looks like the provider rather
 *  than the model. Small: the point is to survive a blip, not to grind against
 *  a real outage, and a run that needs many retries should be re-run instead. */
export const PROVIDER_RETRIES = 2;
export const PROVIDER_RETRY_BACKOFF_MS = 3_000;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Whether a thrown error is the provider failing rather than the model answering
 * badly.
 *
 * Deliberately narrow. Retrying a genuine agent bug would hide it and inflate
 * the score, so only failures that cannot be the model's reasoning qualify:
 * an empty stream, a rate limit, an upstream 5xx, or a dropped socket.
 *
 * Note what retrying cannot fix. The AI SDK reports an exhausted account as
 * `AI_NoOutputGeneratedError` — the same empty-stream message as a real blip —
 * so a run that has run out of credit retries every question and still scores
 * zero. `assertProviderReady` is what catches that case, before the run starts.
 */
export function isTransientProviderError(e: unknown): boolean {
  const msg = (e instanceof Error ? e.message : String(e)).toLowerCase();
  return (
    msg.includes('no output generated')
    || msg.includes('rate limit')
    || msg.includes('429')
    || /\b5\d\d\b/.test(msg)
    || msg.includes('econnreset')
    || msg.includes('etimedout')
    || msg.includes('fetch failed')
    || msg.includes('socket hang up')
  );
}

export interface BenchRecord {
  questionId: number;
  dbId: string;
  difficulty: string;
  question: string;
  /** Whether this question's evidence was loaded into the context layer. */
  contextLoaded: boolean;
  goldSql: string;
  predictedSql: string | null;
  verdict: Verdict;
  /** Present when the verdict is a failure that carries a reason worth reading:
   *  the gate's refusal text, the database error, the thrown message. */
  note?: string;
  /** The agent's prose answer, kept ONLY when no SQL could be extracted from it.
   *  A `no_sql` verdict is otherwise undiagnosable after the run: the record
   *  says the answer had no fenced block but not what it had instead, so there
   *  is no way to tell a refusal from a prose query from a formatting slip.
   *  Stored just for that branch because the full text of 500 answers would
   *  dominate the artifact while adding nothing for the scorable ones. */
  answerText?: string;
  goldRowCount: number | null;
  predictedRowCount: number | null;
  agentSteps: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number | null;
  ms: number;
}

/** A timeout that rejects, so the caller distinguishes a slow answer from none. */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} exceeded ${ms} ms`)), ms);
    p.then((v) => { clearTimeout(timer); resolve(v); },
           (e) => { clearTimeout(timer); reject(e); });
  });
}

function isTimeout(e: unknown): boolean {
  return e instanceof Error && /exceeded \d+ ms/.test(e.message);
}

/**
 * Run the gold SQL to get the reference rows.
 *
 * Executed through the provider directly, NOT through `executeQuery`: gold SQL
 * is BIRD's answer key, and putting it through our risk gate would let a
 * medium-risk refusal of the GOLD query turn into a wrong score for the model.
 * The predicted SQL still goes through the full gate — that asymmetry is
 * deliberate and is stated in the methodology doc.
 */
async function runGold(connectionId: string, sql: string): Promise<unknown[][]> {
  const provider = await getProvider(connectionId);
  try {
    const res = await provider.executeReadOnly(sql);
    return res.rows;
  } finally {
    await provider.close();
  }
}

/** Sum token usage across the agent's steps. Individual steps can report
 *  undefined counts (provider-dependent); those contribute zero rather than
 *  NaN, which would silently poison the run's total cost. */
function sumUsage(steps: readonly { usage?: { inputTokens?: number; outputTokens?: number } }[]): TokenUsage {
  let inputTokens = 0;
  let outputTokens = 0;
  for (const s of steps) {
    inputTokens += s.usage?.inputTokens ?? 0;
    outputTokens += s.usage?.outputTokens ?? 0;
  }
  return { inputTokens, outputTokens };
}

export async function runQuestion(params: {
  connectionId: string;
  question: BenchQuestion;
  model: string;
  contextLoaded: boolean;
}): Promise<BenchRecord> {
  const { connectionId, question: q, model, contextLoaded } = params;
  const started = Date.now();

  const base = {
    questionId: q.question_id, dbId: q.db_id, difficulty: q.difficulty,
    question: q.question, contextLoaded, goldSql: q.SQL,
  };
  const fail = (verdict: Verdict, note: string, extra: Partial<BenchRecord> = {}): BenchRecord => ({
    ...base, predictedSql: null, verdict, note,
    goldRowCount: null, predictedRowCount: null, agentSteps: 0,
    inputTokens: 0, outputTokens: 0, costUsd: null,
    ms: Date.now() - started, ...extra,
  });

  const conn = await getConnection(connectionId);
  if (!conn) return fail('agent_error', 'connection not found');

  // Gold first: a question whose own answer key does not run is a dataset
  // problem, and scoring the model against it would blame the model.
  let goldRows: unknown[][];
  try {
    goldRows = await runGold(connectionId, q.SQL);
  } catch (e) {
    return fail('agent_error', `gold SQL failed: ${e instanceof Error ? e.message : String(e)}`);
  }

  let text: string;
  let steps: readonly { usage?: { inputTokens?: number; outputTokens?: number } }[];
  let attempt = 0;
  for (;;) {
    attempt += 1;
    try {
      const answer = await withTimeout(
        runAgentAnswer({ connectionId, dialect: conn.dialect, question: q.question, actor: 'bench' }),
        QUESTION_TIMEOUT_MS, 'agent loop',
      );
      text = answer.text;
      steps = answer.steps as typeof steps;
      break;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (isTimeout(e)) return fail('timeout', msg, { goldRowCount: goldRows.length });
      if (!isTransientProviderError(e) || attempt > PROVIDER_RETRIES) {
        return fail('agent_error', msg, { goldRowCount: goldRows.length });
      }
      // A provider hiccup is not a wrong answer. Left unretried it scores the
      // same as a model that reasoned badly, and a run that hit four of them
      // reports an accuracy several points below what the model actually earned.
      await sleep(PROVIDER_RETRY_BACKOFF_MS * attempt);
    }
  }

  const usage = sumUsage(steps);
  const common = {
    ...base,
    goldRowCount: goldRows.length,
    agentSteps: steps.length,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    costUsd: costUsd(model, usage),
    ms: Date.now() - started,
  };

  const predictedSql = extractFinalSql(text);
  if (!predictedSql) {
    // An answer with no SQL that also used every available step was cut off
    // rather than composed; see the note on `step_cap` in bench-scorer.ts.
    const exhausted = steps.length >= MAX_STEPS_CHAT;
    return {
      ...common, predictedSql: null, predictedRowCount: null,
      verdict: exhausted ? 'step_cap' : 'no_sql',
      note: exhausted
        ? `no SQL in answer after exhausting the ${MAX_STEPS_CHAT}-step cap`
        : 'answer contained no fenced SQL block',
      answerText: text,
    };
  }

  // Full gate: safety, governed scope, risk tier. `confirmed: true` grants the
  // medium-risk auto-confirm the methodology discloses (there is no human here
  // to press confirm); high risk still refuses, and that refusal is a score of
  // wrong, not a bypass.
  const exec = await executeQuery({ connectionId, sql: predictedSql, actor: 'bench', confirmed: true });

  if (exec.status === 'blocked') {
    return { ...common, predictedSql, verdict: 'gate_blocked', predictedRowCount: null,
             note: exec.blockedReason ?? 'blocked' };
  }
  if (exec.status !== 'ok' || !exec.result) {
    return { ...common, predictedSql, verdict: 'sql_error', predictedRowCount: null,
             note: exec.errorMessage ?? `status ${exec.status}` };
  }

  const rows = exec.result.rows;
  return {
    ...common, predictedSql, predictedRowCount: rows.length,
    verdict: executionMatch(rows, goldRows) ? 'correct' : 'wrong_rows',
  };
}
