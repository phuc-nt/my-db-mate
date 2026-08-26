/**
 * Grouping rules for comparing finished benchmark runs.
 *
 * Split out of `scripts/bench-compare.ts` because both rules here are wrong in
 * ways a table renders plausibly, so both need tests that can go red:
 *
 *  - A run whose questions never reached the model recorded `EX = 0%`. Left in,
 *    it drags an average and sets a spread that describes an exhausted account
 *    rather than a model. Marked runs are excluded, and named, never dropped.
 *  - Spread across differing configurations reports a deliberate difference —
 *    another model, the ablation, a different subset size — as run-to-run noise.
 *    Spread is therefore computed per configuration only.
 */

/** The fields of a run's `summary.json` that comparison depends on. */
export interface ComparableSummary {
  model: string;
  contextLayer: boolean;
  questionCount: number;
  executionAccuracyPct: number;
}

/** Marker files that disqualify a run from a comparison table. */
export const DISQUALIFYING_MARKERS: readonly string[] = ['INVALID.md', 'PARTIAL.md'];

/**
 * The configuration a spread may be computed within. Two runs share a key only
 * when nothing but sampling separates them.
 */
export function configKey(s: ComparableSummary): string {
  return `${s.model} ctx=${s.contextLayer ? 'on' : 'off'} n=${s.questionCount}`;
}

export interface Spread {
  key: string;
  runs: number;
  minPct: number;
  maxPct: number;
  spreadPts: number;
}

/**
 * Per-configuration EX spread, for configurations run more than once.
 *
 * A configuration with a single run yields no spread rather than a spread of
 * zero: zero would read as "reproduced exactly", which one run cannot show.
 */
export function spreadsByConfig(rows: readonly ComparableSummary[]): Spread[] {
  const groups = new Map<string, number[]>();
  for (const s of rows) {
    const key = configKey(s);
    groups.set(key, [...(groups.get(key) ?? []), s.executionAccuracyPct]);
  }
  const out: Spread[] = [];
  for (const [key, ex] of groups) {
    if (ex.length < 2) continue;
    const minPct = Math.min(...ex);
    const maxPct = Math.max(...ex);
    out.push({ key, runs: ex.length, minPct, maxPct, spreadPts: Number((maxPct - minPct).toFixed(1)) });
  }
  return out;
}
