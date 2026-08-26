/**
 * Run the BIRD mini-dev benchmark and write a result artifact.
 *
 *   npm run bench -- --subset 20 --model qwen/qwen3.7-max
 *   npm run bench -- --full --no-context --model deepseek/deepseek-v4-pro
 *
 * Every run writes `bench-results/<stamp>/` containing `summary.json` (the
 * numbers) and `questions.jsonl` (one record per question). The JSONL is the
 * point: a headline accuracy nobody can drill into is a claim, not a result, and
 * the failure taxonomy in the methodology doc is computed from these rows rather
 * than remembered.
 *
 * Sequential by design. Questions could run concurrently, but the run measures
 * latency and cost per question alongside accuracy, and parallel requests share
 * rate limits in a way that would make those two numbers meaningless.
 */
import 'dotenv/config';
import { mkdir, writeFile, appendFile } from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import {
  loadQuestions, stratifiedSample, ensureBenchConnection, cleanupBenchConnections,
  loadEvidenceAsContext, clearBenchContext, countBenchContext,
  runQuestion, tallyVerdicts, assertModel, assertProviderReady, PRICES_AS_OF,
  type BenchQuestion, type BenchRecord, type Verdict,
} from '@/modules/bench';

/** Fixed so two runs of the same subset size draw the SAME questions. A run
 *  that re-samples cannot separate "the model changed" from "the questions did". */
const SAMPLE_SEED = 20260825;

interface Args {
  subset: number | null;
  model: string;
  context: boolean;
  keepConnections: boolean;
}

function parseArgs(argv: readonly string[]): Args {
  const args: Args = { subset: 20, model: '', context: true, keepConnections: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--full') args.subset = null;
    else if (a === '--subset') {
      const n = Number(argv[++i]);
      if (!Number.isInteger(n) || n <= 0) throw new Error(`--subset needs a positive integer, got "${argv[i]}"`);
      args.subset = n;
    } else if (a === '--model') args.model = String(argv[++i] ?? '');
    else if (a === '--no-context') args.context = false;
    else if (a === '--keep-connections') args.keepConnections = true;
    else throw new Error(`unknown flag "${a}"`);
  }
  if (!args.model) throw new Error('--model is required — the result artifact must name the model it measured');
  return args;
}

/**
 * Identifier unique to this run, used both for the results directory and to
 * scope the run's bench connections.
 *
 * The timestamp is only second-resolution, so a random suffix is appended: two
 * runs started in the same second would otherwise share an id, and a shared id
 * means one run's cleanup deletes the other's connections out from under it.
 */
function newRunId(): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  return `${stamp}-${randomBytes(3).toString('hex')}`;
}

/** Directory name sorts chronologically and carries the configuration, so a
 *  results folder is readable without opening anything. */
function runDir(runId: string, model: string, context: boolean, subset: number | null): string {
  const slug = model.replace(/[^a-z0-9]+/gi, '-').toLowerCase();
  return path.resolve(
    process.cwd(), 'bench-results',
    `${runId}__${slug}__${context ? 'context' : 'nocontext'}__${subset ?? 'full'}`,
  );
}

function pct(n: number, total: number): number {
  return total === 0 ? 0 : Math.round((n / total) * 1000) / 10;
}

/** Accuracy broken out by BIRD difficulty. The headline hides the shape: a
 *  system can look fine overall while failing every challenging question. */
function byDifficulty(records: readonly BenchRecord[]): Record<string, { n: number; correct: number; ex: number }> {
  const out: Record<string, { n: number; correct: number; ex: number }> = {};
  for (const r of records) {
    const b = (out[r.difficulty] ??= { n: 0, correct: 0, ex: 0 });
    b.n += 1;
    if (r.verdict === 'correct') b.correct += 1;
  }
  for (const b of Object.values(out)) b.ex = pct(b.correct, b.n);
  return out;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  // Refuse to start on a model mismatch rather than mislabel the artifact.
  const active = await assertModel(args.model);
  console.log(`model: ${active.model} (${active.provider}, from ${active.source})`);

  // An account that cannot pay fails every question as an empty stream and
  // reports EX = 0% in fifteen seconds, which reads as a measurement rather
  // than an outage. Refuse to start instead of publishing that zero.
  const ready = await assertProviderReady(active.provider, process.env.OPENROUTER_API_KEY);
  console.log(`provider: ${ready.detail}`);

  const all = await loadQuestions();
  const questions: BenchQuestion[] = args.subset === null
    ? all
    : stratifiedSample(all, args.subset, SAMPLE_SEED);
  console.log(`questions: ${questions.length} of ${all.length}${args.subset === null ? ' (full)' : ` (seed ${SAMPLE_SEED})`}`);
  console.log(`context layer: ${args.context ? 'ON (BIRD evidence as glossary terms)' : 'OFF (ablation)'}`);

  const runId = newRunId();
  const dir = runDir(runId, args.model, args.context, args.subset);
  await mkdir(dir, { recursive: true });
  const jsonl = path.join(dir, 'questions.jsonl');

  // Connections are created lazily per database and reused; the schema sync is
  // the expensive part and 11 databases cover all 500 questions.
  const connByDb = new Map<string, string>();
  const ensure = async (q: BenchQuestion): Promise<string> => {
    const hit = connByDb.get(q.db_id);
    if (hit) return hit;
    process.stdout.write(`  [setup] ${q.db_id} — introspecting schema...\n`);
    const id = await ensureBenchConnection(runId, q.db_id, q.dbPath);
    connByDb.set(q.db_id, id);
    return id;
  };

  const records: BenchRecord[] = [];
  const started = Date.now();

  for (const [i, q] of questions.entries()) {
    const connectionId = await ensure(q);

    // The ablation is enforced per question and VERIFIED, not assumed: a stale
    // term left by an earlier with-context run would silently invalidate a
    // --no-context result, and that is exactly the direction that would flatter
    // the ablation delta.
    if (args.context) {
      await loadEvidenceAsContext(connectionId, q);
    } else {
      await clearBenchContext(connectionId);
      const left = await countBenchContext(connectionId);
      if (left !== 0) throw new Error(`ablation broken: ${left} bench context terms remain on ${q.db_id}`);
    }

    const rec = await runQuestion({ connectionId, question: q, model: args.model, contextLoaded: args.context });
    records.push(rec);
    await appendFile(jsonl, `${JSON.stringify(rec)}\n`);

    const mark = rec.verdict === 'correct' ? 'OK  ' : 'MISS';
    const runningEx = pct(records.filter((r) => r.verdict === 'correct').length, records.length);
    console.log(
      `[${String(i + 1).padStart(3)}/${questions.length}] ${mark} ${rec.verdict.padEnd(12)} ` +
      `${q.db_id.slice(0, 22).padEnd(22)} ${(rec.ms / 1000).toFixed(1)}s  EX=${runningEx}%`,
    );
  }

  const correct = records.filter((r) => r.verdict === 'correct').length;
  // A record is unpriced either because the model has no listed price or because
  // the question never reached the model at all (an `agent_error` spends nothing
  // and reports null). Only the first case makes the run's total unknowable, so
  // the two are separated here: otherwise one transient provider error blanks the
  // cost of an otherwise fully-priced run, which reads as "we cannot price this
  // model" when the truth is "19 of 20 questions cost this much".
  const spending = records.filter((r) => r.inputTokens > 0 || r.outputTokens > 0);
  const costs = spending.map((r) => r.costUsd).filter((c): c is number => c !== null);
  const allSpendingPriced = costs.length === spending.length;
  const summary = {
    model: args.model,
    provider: active.provider,
    modelSource: active.source,
    contextLayer: args.context,
    subset: args.subset,
    sampleSeed: args.subset === null ? null : SAMPLE_SEED,
    questionCount: records.length,
    datasetTotal: all.length,
    executionAccuracyPct: pct(correct, records.length),
    correct,
    verdicts: tallyVerdicts(records.map((r) => r.verdict) as Verdict[]),
    byDifficulty: byDifficulty(records),
    medianMs: median(records.map((r) => r.ms)),
    totalInputTokens: records.reduce((n, r) => n + r.inputTokens, 0),
    totalOutputTokens: records.reduce((n, r) => n + r.outputTokens, 0),
    // null when the model has no listed price — never a guessed dollar figure.
    totalCostUsd: allSpendingPriced ? round4(costs.reduce((a, b) => a + b, 0)) : null,
    /** Questions that never reached the model, so contributed no cost. Reported
     *  because a total covering 16 of 20 questions is not the same number as one
     *  covering all 20, and the difference must not be invisible. */
    unbilledQuestions: records.length - spending.length,
    pricesAsOf: PRICES_AS_OF,
    wallClockSec: Math.round((Date.now() - started) / 1000),
    finishedAt: new Date().toISOString(),
  };
  await writeFile(path.join(dir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);

  console.log(`\nEX = ${summary.executionAccuracyPct}%  (${correct}/${records.length})`);
  console.log(`verdicts: ${JSON.stringify(summary.verdicts)}`);
  console.log(`by difficulty: ${JSON.stringify(summary.byDifficulty)}`);
  const unbilled = summary.unbilledQuestions > 0 ? ` (${summary.unbilledQuestions} unbilled)` : '';
  console.log(`cost: ${summary.totalCostUsd === null ? 'unpriced model' : `$${summary.totalCostUsd}`}${unbilled}  wall: ${summary.wallClockSec}s`);
  console.log(`artifact: ${dir}`);

  // Bench connections are removed by default so a benchmark run leaves the app's
  // connection list as it found it. --keep-connections is for debugging a run.
  if (!args.keepConnections) {
    for (const id of connByDb.values()) await clearBenchContext(id);
    const removed = await cleanupBenchConnections(runId);
    console.log(`cleaned up ${removed} bench connection(s)`);
  }
}

function median(xs: readonly number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
}

function round4(n: number): number {
  return Math.round(n * 1e4) / 1e4;
}

main().then(
  () => process.exit(0),
  (e: unknown) => {
    console.error('bench failed:', e instanceof Error ? e.stack ?? e.message : e);
    process.exit(1);
  },
);
