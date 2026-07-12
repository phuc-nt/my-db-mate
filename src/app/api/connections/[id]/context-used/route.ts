import { NextResponse } from 'next/server';
import { and, eq, sql as dsql } from 'drizzle-orm';
import { db } from '../../../../../db/client';
import { glossaryTerms, verifiedQueries, columnAnnotations, tableAnnotations } from '../../../../../db/context-schema';
import { embed } from '../../../../../services/embedding-service';

export const runtime = 'nodejs';

// Explicit similarity thresholds — getRelevantContext is top-K with NO floor, so
// provenance/confidence must re-score here or every answer would read "high".
// Tuned on the demo DB; cosine similarity = 1 - pgvector cosine distance.
const HIGH_SIM = 0.6;
const MEDIUM_SIM = 0.45;

/** POST { question, sqlTexts?: string[] } → which curated context plausibly fed
 *  this answer + a coarse confidence. Names only — no SQL/definitions returned.
 *  "Plausibly": recomputed against current context state, not a transcript of
 *  what the agent saw (deterministic for unchanged context). */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await req.json().catch(() => ({}));
  const question = typeof body.question === 'string' ? body.question.slice(0, 2000) : '';
  const sqlTexts: string[] = Array.isArray(body.sqlTexts) ? body.sqlTexts.filter((s: unknown) => typeof s === 'string') : [];
  if (!question.trim()) return NextResponse.json({ confidence: 'low', verified: [], glossary: [], annotations: [] });

  const qEmbedding = await embed(question);
  const vec = `[${qEmbedding.join(',')}]`;

  const verifiedRows = await db
    .select({ question: verifiedQueries.question, distance: dsql<number>`${verifiedQueries.embedding} <=> ${vec}::vector` })
    .from(verifiedQueries)
    .where(and(eq(verifiedQueries.connectionId, id), eq(verifiedQueries.isDisabled, false), eq(verifiedQueries.isBookmark, false)))
    .orderBy(dsql`${verifiedQueries.embedding} <=> ${vec}::vector`)
    .limit(3);
  const verified = verifiedRows
    .map((r) => ({ question: r.question, sim: 1 - Number(r.distance) }))
    .filter((r) => r.sim >= MEDIUM_SIM);

  // Glossary: lexical hit (term/synonym in question) is the strong signal.
  const qLower = question.toLowerCase();
  const terms = await db
    .select({ term: glossaryTerms.term, synonyms: glossaryTerms.synonyms })
    .from(glossaryTerms).where(eq(glossaryTerms.connectionId, id));
  const glossary = terms
    .filter((g) => qLower.includes(g.term.toLowerCase()) || (g.synonyms ?? []).some((s: string) => qLower.includes(s.toLowerCase())))
    .map((g) => g.term);

  // Annotations: only those whose table/column actually appears in the executed
  // SQL of this turn — never the whole connection's annotation list.
  const sqlLower = sqlTexts.join('\n').toLowerCase();
  let annotations: string[] = [];
  if (sqlLower) {
    const [cols, tabs] = await Promise.all([
      db.select({ tableName: columnAnnotations.tableName, columnName: columnAnnotations.columnName })
        .from(columnAnnotations).where(eq(columnAnnotations.connectionId, id)),
      db.select({ tableName: tableAnnotations.tableName })
        .from(tableAnnotations).where(eq(tableAnnotations.connectionId, id)),
    ]);
    annotations = [
      ...tabs.filter((t) => sqlLower.includes(t.tableName.toLowerCase())).map((t) => t.tableName),
      ...cols.filter((c) => sqlLower.includes(c.tableName.toLowerCase()) && sqlLower.includes(c.columnName.toLowerCase()))
        .map((c) => `${c.tableName}.${c.columnName}`),
    ];
  }

  const bestVerified = verified[0]?.sim ?? 0;
  const confidence = bestVerified >= HIGH_SIM ? 'high'
    : bestVerified >= MEDIUM_SIM || glossary.length > 0 || annotations.length > 0 ? 'medium'
    : 'low';

  return NextResponse.json({
    confidence,
    verified: verified.map((v) => ({ question: v.question, sim: Math.round(v.sim * 100) / 100 })),
    glossary,
    annotations: annotations.slice(0, 6),
  });
}
