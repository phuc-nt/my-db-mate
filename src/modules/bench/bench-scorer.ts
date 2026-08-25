/**
 * Execution-accuracy scoring, matched to BIRD's official scorer.
 *
 * BIRD computes `set(predicted_rows) == set(gold_rows)` over Python tuples
 * (evaluation/evaluation_ex.py `calculate_ex`). Three properties fall out of
 * that and all three matter if our number is to sit next to a published one:
 *
 *   - Row ORDER is ignored. A query returning the right rows in a different
 *     order scores 1, even when the question said "ordered by".
 *   - DUPLICATE rows collapse. `set()` of 5 identical rows is one element, so a
 *     missing DISTINCT does not fail. The repo's `eval-service` hashes SORTED
 *     rows without deduping, which is a stricter rule; using it here would
 *     report a lower EX than the same answers earn on the leaderboard.
 *   - Column NAMES are ignored — only values compare, positionally within a row.
 *
 * Deliberately NOT copied: BIRD's Python-side type coercion. Python's `set`
 * treats 1 == 1.0 == True as one element, which would let an integer count
 * match a boolean. We tag each value with its JS type instead, so a genuine
 * type mismatch scores wrong. That is stricter than BIRD in a narrow case, and
 * `docs/benchmark-methodology.md` states it rather than hiding it.
 */
import { createHash } from 'node:crypto';

/**
 * Separators for the canonical text of a result set.
 *
 * Separators alone are not sufficient: a cell whose VALUE contains the
 * separator can forge a boundary, so `[['a'], ['b']]` would hash the same as
 * the single row `[['a<ROW_SEP>string:b']]`. Each row is therefore
 * length-prefixed with its byte count, which no cell content can imitate.
 */
const CELL_SEP = '\u0001';
const ROW_SEP = '\u0002';

/** Canonical text for one cell. Type-tagged so 1 (number) never equals "1"
 *  (string) and NULL never equals the literal string "NULL". */
function tagValue(v: unknown): string {
  if (v === null || v === undefined) return 'ø';
  if (v instanceof Date) return `date:${v.toISOString()}`;
  if (typeof v === 'bigint') return `num:${Number(v)}`;
  if (typeof v === 'object') return `json:${JSON.stringify(v)}`;
  // 5 and 5.0 are the same answer: SQLite returns an integer for COUNT(*) but a
  // float for AVG over integers, and no BIRD question distinguishes the two.
  // `String(5.0)` is already "5" in JS, so integral floats collapse naturally.
  if (typeof v === 'number') return `num:${v}`;
  return `${typeof v}:${String(v)}`;
}

function tagRow(row: readonly unknown[]): string {
  const body = row.map(tagValue).join(CELL_SEP);
  return `${body.length}:${body}`;
}

/** The BIRD-comparable fingerprint of a result set: the SET of its rows. */
export function resultSetHash(rows: readonly (readonly unknown[])[]): string {
  const uniqueSorted = [...new Set(rows.map(tagRow))].sort();
  return createHash('sha256').update(uniqueSorted.join(ROW_SEP)).digest('hex');
}

/** BIRD execution accuracy for one question: true when the row sets are equal. */
export function executionMatch(
  predicted: readonly (readonly unknown[])[],
  gold: readonly (readonly unknown[])[],
): boolean {
  return resultSetHash(predicted) === resultSetHash(gold);
}

/**
 * Why a question scored 0. Reported alongside the headline number because a
 * benchmark that only says "58%" cannot tell you whether the harness is weak,
 * the model is weak, or the safety layer refused — three findings with three
 * different responses.
 */
export type Verdict =
  | 'correct'
  /** SQL ran, rows differ from gold. The model was wrong. */
  | 'wrong_rows'
  /** The agent answered without a final fenced SQL block for us to score. */
  | 'no_sql'
  /** Same symptom as `no_sql` — no SQL to score — but the agent had used every
   *  step available to it, so it was cut off mid-exploration rather than
   *  choosing to reply in prose. Split out because the two have different
   *  causes and different fixes, and merging them hides which is costing points. */
  | 'step_cap'
  /** The safety/scope layer refused to run the generated SQL. Product signal,
   *  never bypassed: a gate the benchmark turns off is not a gate. */
  | 'gate_blocked'
  /** The generated SQL raised a database error. */
  | 'sql_error'
  /** The agent loop or the query exceeded its time budget. */
  | 'timeout'
  /** The agent loop threw (provider error, crash) before producing an answer. */
  | 'agent_error';

export const VERDICTS: readonly Verdict[] = [
  'correct', 'wrong_rows', 'no_sql', 'step_cap', 'gate_blocked', 'sql_error', 'timeout', 'agent_error',
];

/** Counts per verdict, with every verdict present at zero so a taxonomy table
 *  never silently omits a category that happened not to occur. */
export function tallyVerdicts(verdicts: readonly Verdict[]): Record<Verdict, number> {
  const out = Object.fromEntries(VERDICTS.map((v) => [v, 0])) as Record<Verdict, number>;
  for (const v of verdicts) out[v] += 1;
  return out;
}

/**
 * Pull the SQL the agent settled on out of its prose answer.
 *
 * The LAST fenced block wins, not the first: the agent narrates its work, and
 * an answer that shows an exploratory `SELECT DISTINCT status ...` before the
 * real query would otherwise be scored on the exploration. Unfenced prose is
 * treated as no SQL at all rather than pattern-matched out of the text — a
 * benchmark that guesses which sentence was the query is measuring the guess.
 */
export function extractFinalSql(text: string): string | null {
  const blocks = [...text.matchAll(/```(?:sql)?[ \t]*\r?\n([\s\S]*?)```/gi)]
    .map((m) => m[1].trim())
    .filter((b) => /^\s*(select|with)\b/i.test(b));
  if (blocks.length === 0) return null;
  return blocks[blocks.length - 1].replace(/;\s*$/, '').trim();
}
