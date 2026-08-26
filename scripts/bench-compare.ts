/**
 * Tabulate finished benchmark runs from their artifacts.
 *
 *   npx tsx scripts/bench-compare.ts                       # every run
 *   npx tsx scripts/bench-compare.ts <runId> <runId> ...   # named runs
 *
 * Reads `summary.json` only. The numbers in `docs/benchmark-methodology.md` are
 * produced by this script rather than transcribed from console output, so a
 * quoted figure can always be re-derived from the artifact that produced it.
 *
 * Runs that never wrote a summary (crashed, or still in flight) are listed
 * separately instead of being skipped silently: an incomplete run omitted from
 * a comparison table looks exactly like a run that was never attempted.
 *
 * A run directory carrying an `INVALID.md` or `PARTIAL.md` marker is kept out of
 * the table and the spread, and named underneath with its reason. Two runs whose
 * questions never reached the model recorded `EX = 0%`; averaging those in, or
 * letting them set the spread, describes a broken account rather than a model.
 */
import { readdir, readFile, access } from 'node:fs/promises';
import path from 'node:path';
// Imported from the file rather than the module barrel: the barrel pulls in
// `bench-connections`, which opens the app's Postgres pool. This script only
// reads JSON off disk and must run without DATABASE_URL set.
import { DISQUALIFYING_MARKERS, spreadsByConfig } from '@/modules/bench/bench-comparison';

const ROOT = path.join(process.cwd(), 'bench-results');

interface Summary {
  model: string; contextLayer: boolean; questionCount: number;
  executionAccuracyPct: number; correct: number;
  verdicts: Record<string, number>;
  byDifficulty: Record<string, { n: number; correct: number; ex: number }>;
  medianMs: number; totalCostUsd: number | null; unbilledQuestions: number;
  wallClockSec: number;
}

/** The marker file disqualifying a run, or null when the run counts. */
async function findMarker(id: string): Promise<string | null> {
  for (const name of DISQUALIFYING_MARKERS) {
    try {
      await access(path.join(ROOT, id, name));
      return name.replace('.md', '');
    } catch { /* absent: not disqualified by this marker */ }
  }
  return null;
}

async function main(): Promise<void> {
  const wanted = process.argv.slice(2);
  const dirs = wanted.length > 0 ? wanted : (await readdir(ROOT)).sort();

  const rows: Array<{ id: string; s: Summary }> = [];
  const missing: string[] = [];
  const excluded: string[] = [];
  for (const id of dirs) {
    const marker = await findMarker(id);
    if (marker !== null) { excluded.push(`${id} (${marker})`); continue; }
    try {
      rows.push({ id, s: JSON.parse(await readFile(path.join(ROOT, id, 'summary.json'), 'utf8')) as Summary });
    } catch {
      missing.push(id);
    }
  }

  console.log('| run | model | ctx | n | EX% | correct | median s | cost $ | wall s |');
  console.log('|---|---|---|---|---|---|---|---|---|');
  for (const { id, s } of rows) {
    const cost = s.totalCostUsd === null ? 'n/a' : s.totalCostUsd.toFixed(4);
    const unbilled = s.unbilledQuestions > 0 ? ` (${s.unbilledQuestions} unbilled)` : '';
    console.log(
      `| ${id} | ${s.model} | ${s.contextLayer ? 'on' : 'off'} | ${s.questionCount} | ${s.executionAccuracyPct} | `
      + `${s.correct} | ${(s.medianMs / 1000).toFixed(1)} | ${cost}${unbilled} | ${s.wallClockSec} |`,
    );
  }

  // Spread is per configuration, never across the table: see `bench-comparison`.
  for (const sp of spreadsByConfig(rows.map((r) => r.s))) {
    console.log(`\nEX spread [${sp.key}] over ${sp.runs} runs: ${sp.minPct}–${sp.maxPct} (${sp.spreadPts} pts)`);
  }
  for (const { id, s } of rows) {
    console.log(`\n${id}\n  verdicts:  ${JSON.stringify(s.verdicts)}\n  difficulty: ${JSON.stringify(s.byDifficulty)}`);
  }
  if (missing.length > 0) {
    console.log(`\nno summary.json (crashed or in flight): ${missing.join(', ')}`);
  }
  if (excluded.length > 0) {
    console.log(`\nexcluded by marker: ${excluded.join(', ')}`);
  }
}

void main();
