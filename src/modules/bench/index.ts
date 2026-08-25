/**
 * Benchmark harness: public surface.
 *
 * The module exists to answer one question with a number that survives being
 * checked: how often does this product's agent produce the RIGHT rows for a
 * natural-language question, against a public dataset with published gold SQL?
 *
 * It is not wired into the app. Nothing under `src/app/` imports it; the only
 * entry point is `scripts/bench-run.ts`. That keeps the benchmark's test-only
 * dependencies (dataset files, a 800 MB download) out of the product build.
 */
export { loadQuestions, BENCH_DATA_ROOT, datasetMissingError } from './bench-dataset';
export type { BirdQuestion, BenchQuestion } from './bench-dataset';

export { resultSetHash, executionMatch, extractFinalSql, tallyVerdicts, VERDICTS } from './bench-scorer';
export type { Verdict } from './bench-scorer';

export { stratifiedSample } from './bench-sampler';

export { ensureBenchConnection, cleanupBenchConnections, BENCH_PREFIX } from './bench-connections';
export {
  loadEvidenceAsContext, clearBenchContext, countBenchContext, BENCH_TERM_PREFIX,
} from './bench-context';

export { costUsd, MODEL_PRICES, PRICES_AS_OF } from './bench-pricing';
export type { ModelPrice, TokenUsage } from './bench-pricing';

export { resolveActiveModel, assertModel } from './bench-model';
export type { ResolvedModel } from './bench-model';

export { runQuestion, QUESTION_TIMEOUT_MS } from './bench-runner';
export type { BenchRecord } from './bench-runner';
