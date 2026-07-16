/**
 * Context layer read/write + retrieval. `getRelevantContext` is the single entry
 * the agent (and P4 MCP) uses to pull annotations, glossary hits, and verified-query
 * few-shots for a question. Glossary uses BOTH keyword and vector match (RT-F2 —
 * never rely on vectors alone); verified queries use vector top-K.
 */
import { and, eq, sql } from 'drizzle-orm';
import { db } from '../db/client';
import {
  tableAnnotations,
  columnAnnotations,
  glossaryTerms,
  manualRelationships,
  verifiedQueries,
} from '../db/context-schema';
import { metrics } from '../db/metric-schema';
import { embed } from './embedding-service';

// Cosine-distance floors (pgvector `<=>` ∈ [0,2]) — an item is only injected into the
// prompt when it is genuinely close to the question. A wrongly-injected governed metric
// or unrelated "verified pattern" is worse than none. Tuned against the eval fixture.
const METRIC_DISTANCE_FLOOR = 0.35;
const VERIFIED_DISTANCE_FLOOR = 0.6;

// ---------- Annotations ----------
export async function upsertTableAnnotation(input: {
  connectionId: string; tableName: string; description?: string; businessAlias?: string; isDeprecated?: boolean; provenance?: string; confidence?: number;
}) {
  const existing = await db.select().from(tableAnnotations)
    .where(and(eq(tableAnnotations.connectionId, input.connectionId), eq(tableAnnotations.tableName, input.tableName)));
  if (existing[0]) {
    await db.update(tableAnnotations).set({ ...input, updatedAt: new Date() }).where(eq(tableAnnotations.id, existing[0].id));
    return existing[0].id;
  }
  const [row] = await db.insert(tableAnnotations).values(input).returning();
  return row.id;
}

export async function upsertColumnAnnotation(input: {
  connectionId: string; tableName: string; columnName: string; description?: string; businessAlias?: string; isSensitive?: boolean;
  provenance?: string; confidence?: number;
}) {
  const existing = await db.select().from(columnAnnotations).where(and(
    eq(columnAnnotations.connectionId, input.connectionId),
    eq(columnAnnotations.tableName, input.tableName),
    eq(columnAnnotations.columnName, input.columnName),
  ));
  if (existing[0]) {
    await db.update(columnAnnotations).set({ ...input, updatedAt: new Date() }).where(eq(columnAnnotations.id, existing[0].id));
    return existing[0].id;
  }
  const [row] = await db.insert(columnAnnotations).values(input).returning();
  return row.id;
}

// ---------- Glossary ----------
export async function addGlossaryTerm(input: {
  connectionId: string; term: string; definition: string; sqlMapping?: string; synonyms?: string[];
  provenance?: string; confidence?: number;
}) {
  const embedding = await embed(`${input.term}: ${input.definition}`);
  const [row] = await db.insert(glossaryTerms).values({ ...input, embedding }).returning();
  return row;
}

export async function listGlossary(connectionId: string) {
  return db.select().from(glossaryTerms).where(eq(glossaryTerms.connectionId, connectionId));
}

// ---------- Manual relationships ----------
export async function addManualRelationship(input: {
  connectionId: string; fromTable: string; fromColumn: string; toTable: string; toColumn: string; note?: string;
}) {
  const [row] = await db.insert(manualRelationships).values(input).returning();
  return row;
}

// ---------- Verified queries ----------
export async function addVerifiedQuery(input: {
  connectionId: string; question: string; sql: string; tablesUsed?: string[];
}) {
  const embedding = await embed(input.question);
  const [row] = await db.insert(verifiedQueries).values({ ...input, embedding }).returning();
  return row;
}

/** Bookmark = a personal saved query (P9-A4). Stored in verified_queries with
 *  isBookmark=true so there's no near-duplicate table; it's excluded from few-shot
 *  retrieval. question doubles as the bookmark name (column is NOT NULL). No
 *  embedding is computed — bookmarks aren't retrieved by similarity. */
export async function addBookmark(input: { connectionId: string; name: string; sql: string }) {
  const [row] = await db.insert(verifiedQueries)
    .values({ connectionId: input.connectionId, question: input.name, sql: input.sql, isBookmark: true })
    .returning({ id: verifiedQueries.id });
  return row;
}

export async function listBookmarks(connectionId: string) {
  return db.select({ id: verifiedQueries.id, name: verifiedQueries.question, sql: verifiedQueries.sql })
    .from(verifiedQueries)
    .where(and(eq(verifiedQueries.connectionId, connectionId), eq(verifiedQueries.isBookmark, true)))
    .orderBy(verifiedQueries.createdAt);
}

export async function deleteBookmark(connectionId: string, id: string) {
  // Scope by connection so a bookmark can't be deleted via another connection's URL.
  await db.delete(verifiedQueries)
    .where(and(eq(verifiedQueries.id, id), eq(verifiedQueries.connectionId, connectionId), eq(verifiedQueries.isBookmark, true)));
}

export async function setVerifiedQueryDisabled(id: string, disabled: boolean) {
  await db.update(verifiedQueries).set({ isDisabled: disabled }).where(eq(verifiedQueries.id, id));
}

// ---------- Retrieval ----------
export interface RelevantContext {
  tableAnnotations: { tableName: string; description: string | null; businessAlias: string | null; isDeprecated: boolean }[];
  columnAnnotations: { tableName: string; columnName: string; description: string | null; businessAlias: string | null; isSensitive: boolean }[];
  glossaryHits: { term: string; definition: string; sqlMapping: string | null }[];
  manualRelationships: { fromTable: string; fromColumn: string; toTable: string; toColumn: string }[];
  verifiedExamples: { question: string; sql: string }[];
  metrics: { name: string; description: string | null; sql: string; dimensions: string[] | null; distance: number }[];
}

/** Pull the context relevant to a question for one connection. */
export async function getRelevantContext(question: string, connectionId: string): Promise<RelevantContext> {
  const qEmbedding = await embed(question);
  const vecLiteral = `[${qEmbedding.join(',')}]`;

  // Drop items whose confidence is below the floor (red-team H2: confidence must
  // actually gate what reaches the prompt, not just decorate the UI). Auto/mined
  // items get a lower confidence, so a low-confidence guessed annotation can be
  // excluded from generation while still visible for human review in the Hub.
  const MIN_CONFIDENCE = 0.3;

  const [tAnnAll, cAnnAll, rels] = await Promise.all([
    db.select().from(tableAnnotations).where(eq(tableAnnotations.connectionId, connectionId)),
    db.select().from(columnAnnotations).where(eq(columnAnnotations.connectionId, connectionId)),
    db.select().from(manualRelationships).where(eq(manualRelationships.connectionId, connectionId)),
  ]);
  const tAnn = tAnnAll.filter((t) => (t.confidence ?? 1) >= MIN_CONFIDENCE);
  const cAnn = cAnnAll.filter((c) => (c.confidence ?? 1) >= MIN_CONFIDENCE);

  // Glossary: keyword hits (term/synonym appears in question) UNION vector top-3.
  // Confidence-floored so a low-confidence auto glossary term never enters the prompt.
  const qLower = question.toLowerCase();
  const allTerms = (await listGlossary(connectionId)).filter((g) => (g.confidence ?? 1) >= MIN_CONFIDENCE);
  const keywordHits = allTerms.filter((g) =>
    qLower.includes(g.term.toLowerCase()) || (g.synonyms ?? []).some((s) => qLower.includes(s.toLowerCase())),
  );
  const vectorGloss = await db
    .select({ term: glossaryTerms.term, definition: glossaryTerms.definition, sqlMapping: glossaryTerms.sqlMapping })
    .from(glossaryTerms)
    .where(and(eq(glossaryTerms.connectionId, connectionId), sql`${glossaryTerms.confidence} >= ${MIN_CONFIDENCE}`))
    .orderBy(sql`${glossaryTerms.embedding} <=> ${vecLiteral}::vector`)
    .limit(3);
  const glossMap = new Map<string, { term: string; definition: string; sqlMapping: string | null }>();
  for (const g of [...keywordHits, ...vectorGloss]) glossMap.set(g.term, { term: g.term, definition: g.definition, sqlMapping: g.sqlMapping });

  // Verified queries: vector top-5 within the distance floor (excluding disabled AND
  // personal bookmarks — a bookmark is a quick-run saved query, not a few-shot example,
  // A4). The floor keeps an unrelated example from being injected as a "verified pattern".
  const verified = await db
    .select({ question: verifiedQueries.question, sql: verifiedQueries.sql })
    .from(verifiedQueries)
    .where(and(
      eq(verifiedQueries.connectionId, connectionId),
      eq(verifiedQueries.isDisabled, false),
      eq(verifiedQueries.isBookmark, false),
      sql`(${verifiedQueries.embedding} <=> ${vecLiteral}::vector) <= ${VERIFIED_DISTANCE_FLOOR}`,
    ))
    .orderBy(sql`${verifiedQueries.embedding} <=> ${vecLiteral}::vector`)
    .limit(5);

  // Governed metrics: vector top-3 within the distance floor, per connection. A metric
  // with no embedding yet (pre-backfill) is skipped by the IS NOT NULL guard, not crashed.
  const metricRows = await db
    .select({
      name: metrics.name,
      description: metrics.description,
      sql: metrics.sql,
      dimensions: metrics.dimensions,
      // Cosine distance to the question — carried so the adherence lint can apply a
      // TIGHTER gate than injection: a metric injected as context (≤ floor) is not
      // necessarily one the answer MUST obey filter-for-filter.
      distance: sql<number>`(${metrics.embedding} <=> ${vecLiteral}::vector)`,
    })
    .from(metrics)
    .where(and(
      eq(metrics.connectionId, connectionId),
      sql`${metrics.embedding} IS NOT NULL`,
      sql`(${metrics.embedding} <=> ${vecLiteral}::vector) <= ${METRIC_DISTANCE_FLOOR}`,
    ))
    .orderBy(sql`${metrics.embedding} <=> ${vecLiteral}::vector`)
    .limit(3);

  return {
    tableAnnotations: tAnn.map((t) => ({ tableName: t.tableName, description: t.description, businessAlias: t.businessAlias, isDeprecated: t.isDeprecated })),
    columnAnnotations: cAnn.map((c) => ({ tableName: c.tableName, columnName: c.columnName, description: c.description, businessAlias: c.businessAlias, isSensitive: c.isSensitive })),
    glossaryHits: [...glossMap.values()],
    manualRelationships: rels.map((r) => ({ fromTable: r.fromTable, fromColumn: r.fromColumn, toTable: r.toTable, toColumn: r.toColumn })),
    verifiedExamples: verified,
    metrics: metricRows,
  };
}

/** Render relevant context as a compact prompt block for the agent. */
export function renderContextForPrompt(ctx: RelevantContext): string {
  const parts: string[] = [];
  if (ctx.glossaryHits.length) {
    parts.push('Business glossary:\n' + ctx.glossaryHits.map((g) =>
      `- ${g.term}: ${g.definition}${g.sqlMapping ? ` [SQL: ${g.sqlMapping}]` : ''}`).join('\n'));
  }
  const annotated = ctx.tableAnnotations.filter((t) => t.description || t.businessAlias);
  if (annotated.length) {
    parts.push('Table notes:\n' + annotated.map((t) =>
      `- ${t.tableName}${t.businessAlias ? ` (aka ${t.businessAlias})` : ''}: ${t.description ?? ''}${t.isDeprecated ? ' [DEPRECATED]' : ''}`).join('\n'));
  }
  const colNotes = ctx.columnAnnotations.filter((c) => c.description || c.businessAlias);
  if (colNotes.length) {
    parts.push('Column notes:\n' + colNotes.map((c) =>
      `- ${c.tableName}.${c.columnName}${c.businessAlias ? ` (aka ${c.businessAlias})` : ''}: ${c.description ?? ''}`).join('\n'));
  }
  if (ctx.manualRelationships.length) {
    parts.push('Known relationships:\n' + ctx.manualRelationships.map((r) =>
      `- ${r.fromTable}.${r.fromColumn} -> ${r.toTable}.${r.toColumn}`).join('\n'));
  }
  if (ctx.verifiedExamples.length) {
    parts.push('Verified example queries (follow these patterns):\n' + ctx.verifiedExamples.map((v) =>
      `Q: ${v.question}\nSQL: ${v.sql}`).join('\n\n'));
  }
  if (ctx.metrics.length) {
    parts.push('Governed metrics (authoritative definitions — when the question matches one, use or adapt its SQL, do NOT invent a different aggregation):\n' +
      ctx.metrics.map((m) =>
        `- ${m.name}${m.description ? `: ${m.description}` : ''}\n  SQL: ${m.sql}${m.dimensions?.length ? `\n  dimensions: ${m.dimensions.join(', ')}` : ''}`,
      ).join('\n'));
  }
  return parts.join('\n\n');
}
