/**
 * Deterministic answer-verify checks — the "verify" step of the chat agent loop.
 * Pure functions (no DB, no LLM): given a successful query result, run cheap
 * sanity checks and return pass/warn/skip. A warn never blocks — it surfaces in
 * the chat as a caution and is fed back to the agent so it can reconsider.
 *
 * The signature check that matters most is `metric-magnitude`: comparing the
 * answer's number against a governed metric's OWN recent history (the cache that
 * runMetric populates). No smarter model has that accumulated observation — it's
 * a moat-side check, not an intelligence one.
 */
import { toJsonSafe } from './json-safe';

export type CheckStatus = 'pass' | 'warn' | 'skip';
export interface VerifyCheck {
  id: 'metric-magnitude' | 'date-coverage' | 'duplicate-rows' | 'row-cap';
  status: CheckStatus;
  note?: string;
}

/** Compact metric history the magnitude check compares against. */
export interface MetricLastRun {
  latest: number | null;
  prev: number | null;
  deltaPct: number | null;
  latestT: string | null;
}

export interface AnswerCheckInput {
  sql: string;
  columns: string[];
  rows: unknown[][];
  /** Nearest governed metric matched to the question, with its cached run and grain. */
  metric?: { lastRun: MetricLastRun; timeGrain: string } | null;
  /** The row cap the executor injects when the query has no explicit LIMIT. A
   *  result hitting this is truncated; total-row checks skip. */
  enforcedLimit: number;
  /** True when the executor injected the cap (no user LIMIT) — only then does
   *  rows.length === enforcedLimit mean truncation. */
  limitInjected: boolean;
}

const TEMPORAL_COL = /date|time|month|year|day|week|quarter|created|_at$/i;
const ISO_DATE = /'(\d{4}-\d{2}-\d{2})'/g;

export function runAnswerChecks(input: AnswerCheckInput): { checks: VerifyCheck[] } {
  const truncated = input.limitInjected && input.rows.length >= input.enforcedLimit;
  const checks: VerifyCheck[] = [
    rowCapCheck(input, truncated),
    metricMagnitudeCheck(input),
    dateCoverageCheck(input, truncated),
    duplicateRowsCheck(input, truncated),
  ];
  return { checks };
}

function rowCapCheck(input: AnswerCheckInput, truncated: boolean): VerifyCheck {
  if (!truncated) return { id: 'row-cap', status: 'pass' };
  return { id: 'row-cap', status: 'warn', note: `Result hit the ${input.enforcedLimit}-row cap — it may be truncated, so any total or aggregate could be incomplete.` };
}

/** Compare a scalar/temporal answer against the metric's recent magnitude. Fires
 *  conservatively to avoid crying wolf on legitimate re-scoping (e.g. a yearly
 *  total vs a monthly metric). */
function metricMagnitudeCheck(input: AnswerCheckInput): VerifyCheck {
  const m = input.metric;
  if (!m || (m.lastRun.latest == null && m.lastRun.prev == null)) return { id: 'metric-magnitude', status: 'skip' };

  const numericCols = input.columns.map((_, i) => input.rows.every((r) => r[i] == null || !Number.isNaN(Number(r[i]))));
  const numericIdx = numericCols.findIndex(Boolean);
  if (numericIdx === -1) return { id: 'metric-magnitude', status: 'skip' };

  // latest is often a partial current bucket (mid-month) → compare against the
  // larger of the two most recent points so a normal mid-period dip isn't a warn.
  const ref = Math.max(Math.abs(m.lastRun.latest ?? 0), Math.abs(m.lastRun.prev ?? 0));
  if (ref === 0) return { id: 'metric-magnitude', status: 'skip' };

  const scalar = input.rows.length === 1 && input.columns.length === 1;
  const resultGrainMatches = guessResultGrain(input.columns, input.rows) === m.timeGrain;

  // A scalar grand total gets the loose 100× gate (a yearly total can be ~12× a
  // monthly metric legitimately). A per-bucket breakdown whose grain matches the
  // metric's grain is directly comparable → tighter 10× gate.
  const threshold = scalar ? 100 : resultGrainMatches ? 10 : 100;

  const maxVal = Math.max(...input.rows.map((r) => Math.abs(Number(r[numericIdx]))).filter((v) => !Number.isNaN(v)), 0);
  if (maxVal === 0) return { id: 'metric-magnitude', status: 'skip' };

  const ratio = maxVal / ref;
  if (ratio >= threshold || ratio <= 1 / threshold) {
    const fmt = (n: number) => (Math.abs(n) >= 1000 ? `${(n / 1000).toFixed(1)}K` : String(Math.round(n)));
    return {
      id: 'metric-magnitude',
      status: 'warn',
      note: `This number (~${fmt(maxVal)}) is ${ratio >= 1 ? `${Math.round(ratio)}×` : `1/${Math.round(1 / ratio)}`} the tracked metric's recent value (~${fmt(ref)}). Double-check the filters/grouping match the metric's definition.`,
    };
  }
  return { id: 'metric-magnitude', status: 'pass' };
}

/** If the SQL pins a date range and the result has a temporal column, warn when
 *  the returned rows cover far less of the range than asked. */
function dateCoverageCheck(input: AnswerCheckInput, truncated: boolean): VerifyCheck {
  if (truncated) return { id: 'date-coverage', status: 'skip' };
  const dates = [...input.sql.matchAll(ISO_DATE)].map((mm) => mm[1]).sort();
  if (dates.length < 2) return { id: 'date-coverage', status: 'skip' };
  const rangeFrom = dates[0], rangeTo = dates[dates.length - 1];

  const tempIdx = input.columns.findIndex((c) => TEMPORAL_COL.test(c));
  if (tempIdx === -1) return { id: 'date-coverage', status: 'skip' };
  const vals = input.rows.map((r) => String(r[tempIdx] ?? '')).filter((s) => /^\d{4}-\d{2}/.test(s)).sort();
  if (vals.length < 2) return { id: 'date-coverage', status: 'skip' };

  const askDays = daysBetween(rangeFrom, rangeTo);
  const gotDays = daysBetween(vals[0].slice(0, 10).padEnd(10, '-01'), vals[vals.length - 1].slice(0, 10).padEnd(10, '-01'));
  if (askDays <= 0) return { id: 'date-coverage', status: 'skip' };
  if (gotDays / askDays < 0.6) {
    return { id: 'date-coverage', status: 'warn', note: `The result covers ${vals[0]}…${vals[vals.length - 1]} but the query asked for ${rangeFrom}…${rangeTo} — the data may not span the full range requested.` };
  }
  return { id: 'date-coverage', status: 'pass' };
}

/** A JOIN that fans out silently duplicates rows and inflates SUM/COUNT. Only
 *  flag when the SQL actually joins — a projection with repeated rows is normal. */
function duplicateRowsCheck(input: AnswerCheckInput, truncated: boolean): VerifyCheck {
  if (truncated) return { id: 'duplicate-rows', status: 'skip' };
  if (!/\bjoin\b/i.test(input.sql)) return { id: 'duplicate-rows', status: 'skip' };
  const seen = new Set<string>();
  let dups = 0;
  for (const r of input.rows) {
    const key = JSON.stringify(toJsonSafe(r)); // BigInt-safe
    if (seen.has(key)) dups++;
    else seen.add(key);
  }
  if (dups > 0) {
    return { id: 'duplicate-rows', status: 'warn', note: `${dups} duplicate row(s) — the JOIN may be fanning out and inflating totals. Consider DISTINCT or checking the join keys.` };
  }
  return { id: 'duplicate-rows', status: 'pass' };
}

/** Guess the bucket size of a temporal result column from its first values, so
 *  the magnitude check can tell a same-grain comparison from a re-scoped one. */
function guessResultGrain(columns: string[], rows: unknown[][]): string | null {
  const idx = columns.findIndex((c) => TEMPORAL_COL.test(c));
  if (idx === -1 || rows.length === 0) return null;
  const v = String(rows[0][idx] ?? '');
  if (/^\d{4}-\d{2}-\d{2}/.test(v)) return 'day';
  if (/^\d{4}-\d{2}$/.test(v)) return 'month';
  if (/^\d{4}$/.test(v)) return 'year';
  if (/^\d{4}-W\d{2}$/i.test(v)) return 'week';
  return null;
}

function daysBetween(a: string, b: string): number {
  const da = Date.parse(`${a}T00:00:00Z`), db = Date.parse(`${b}T00:00:00Z`);
  if (Number.isNaN(da) || Number.isNaN(db)) return -1;
  return Math.abs(db - da) / 86_400_000;
}
