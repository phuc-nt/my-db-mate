/**
 * The ablation: BIRD's `evidence` field as curated context.
 *
 * Every BIRD question ships an `evidence` string — expert external knowledge
 * like "eligible free rate = Free Meal Count / Enrollment". Leaderboard entries
 * paste it straight into the prompt. This product's claim is that such
 * knowledge belongs in a curated layer that is RETRIEVED per question, not
 * pasted per question, so the ablation stores it as a glossary term and lets
 * normal retrieval find it.
 *
 * That makes `--no-context` a real ablation of OUR layer rather than a
 * removal of BIRD's evidence from the prompt: with context on, the agent has
 * to retrieve the right term; with it off, the term is not there at all.
 *
 * Two properties this must have to be honest:
 *   - Storing evidence must not leak the gold SQL. `evidence` never contains
 *     it, but the assertion is cheap and the alternative is a benchmark that
 *     scores its own answer key.
 *   - The stored terms must be REMOVED between configurations, or a --no-context
 *     run following a with-context run would still retrieve them and the
 *     ablation would measure nothing.
 */
import { and, eq, like } from 'drizzle-orm';
import { db } from '@/core/db/client';
import { glossaryTerms } from '@/core/db/context-schema';
import { addGlossaryTerm } from '@/modules/context-studio';
import type { BenchQuestion } from './bench-dataset';

/** Marks a glossary row as this harness's. Cleanup deletes by this only. */
export const BENCH_TERM_PREFIX = 'bench-evidence-';

function termName(questionId: number): string {
  return `${BENCH_TERM_PREFIX}${questionId}`;
}

/**
 * Store one question's evidence as a retrievable glossary term.
 *
 * Idempotent: re-running the benchmark must not accumulate duplicate terms,
 * which would skew retrieval toward whichever question ran most often.
 */
export async function loadEvidenceAsContext(connectionId: string, q: BenchQuestion): Promise<boolean> {
  const evidence = q.evidence?.trim();
  if (!evidence) return false;

  const term = termName(q.question_id);
  const [existing] = await db.select({ id: glossaryTerms.id })
    .from(glossaryTerms)
    .where(and(eq(glossaryTerms.connectionId, connectionId), eq(glossaryTerms.term, term)))
    .limit(1);
  if (existing) return true;

  await addGlossaryTerm({
    connectionId,
    term,
    definition: evidence,
    provenance: 'bird-evidence',
    confidence: 1,
  });
  return true;
}

/** Remove every glossary term this harness stored on a connection. Without
 *  this, a `--no-context` run after a with-context run still retrieves them. */
export async function clearBenchContext(connectionId: string): Promise<number> {
  const rows = await db.delete(glossaryTerms)
    .where(and(
      eq(glossaryTerms.connectionId, connectionId),
      like(glossaryTerms.term, `${BENCH_TERM_PREFIX}%`),
    ))
    .returning({ id: glossaryTerms.id });
  return rows.length;
}

/** How many bench terms a connection currently holds. The runner asserts this
 *  is zero before every `--no-context` question, so the ablation is verified
 *  rather than assumed.
 *
 *  The with-context branch is deliberately not asserted symmetrically. A silent
 *  failure to load would make that run behave like the ablation and SHRINK the
 *  measured delta, so it cannot inflate the result the benchmark is used to
 *  claim; a stale term surviving into a `--no-context` run would inflate it,
 *  which is why only that direction throws. */
export async function countBenchContext(connectionId: string): Promise<number> {
  const rows = await db.select({ id: glossaryTerms.id })
    .from(glossaryTerms)
    .where(and(
      eq(glossaryTerms.connectionId, connectionId),
      like(glossaryTerms.term, `${BENCH_TERM_PREFIX}%`),
    ));
  return rows.length;
}
