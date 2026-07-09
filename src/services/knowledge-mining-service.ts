/**
 * Knowledge Inbox mining: read a chat session transcript + its successful queries
 * and propose context additions (glossary terms, annotations, verified queries)
 * for human approval. The inbox is the human gate — mined junk never reaches the
 * context store until a DBA accepts it.
 */
import { generateText } from 'ai';
import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import { db } from '../db/client';
import { knowledgeSuggestions, glossaryTerms, verifiedQueries } from '../db/context-schema';
import { getMessages } from './session-service';
import { chatSessions, queryRuns } from '../db/schema';
import { addGlossaryTerm, addVerifiedQuery, upsertTableAnnotation, upsertColumnAnnotation, addManualRelationship } from './context-service';

function model() {
  const openrouter = createOpenRouter({ apiKey: process.env.OPENROUTER_API_KEY! });
  return openrouter(process.env.OPENROUTER_MODEL ?? 'qwen/qwen3.7-max');
}

// Lenient: models return confidence as number OR enum, and alias/synonym fields
// as string OR array. Normalize downstream rather than reject the whole batch.
const SUGGESTION = z.object({
  suggestions: z.array(z.object({
    kind: z.enum(['glossary', 'table_annotation', 'column_annotation', 'verified_query']),
    reason: z.string().optional().default(''),
    confidence: z.union([z.string(), z.number()]).optional(),
    payload: z.record(z.string(), z.unknown()),
  })),
});

/** Coerce a field the model may return as string | string[] into a single string. */
function asText(v: unknown): string | undefined {
  if (v == null) return undefined;
  return Array.isArray(v) ? v.filter(Boolean).map(String).join(', ') : String(v);
}

/** Mine one session into pending suggestions. Returns count created. */
export async function mineSession(sessionId: string): Promise<number> {
  const [session] = await db.select().from(chatSessions).where(eq(chatSessions.id, sessionId));
  if (!session) throw new Error('session not found');

  const messages = await getMessages(sessionId);
  const runs = await db.select().from(queryRuns).where(and(eq(queryRuns.sessionId, sessionId), eq(queryRuns.status, 'ok')));
  if (messages.length === 0) return 0;

  const transcript = messages.map((m) => `${m.role}: ${m.content}`).join('\n');
  const successfulSql = runs.map((r) => r.sql).join('\n---\n');

  const { text } = await generateText({
    model: model(),
    system:
      'You extract reusable DB knowledge from a chat transcript. Propose ONLY well-supported items. ' +
      'Return STRICT JSON matching: {"suggestions":[{"kind","reason","confidence","payload"}]}. ' +
      'kinds: glossary {term,definition,sqlMapping?}, table_annotation {tableName,description?,businessAlias?}, ' +
      'column_annotation {tableName,columnName,description?,businessAlias?,isSensitive?}, ' +
      'verified_query {question,sql}. Only include verified_query when a SQL actually ran successfully. ' +
      'No markdown, JSON only.',
    prompt: `Transcript:\n${transcript}\n\nSuccessful SQL executed:\n${successfulSql || '(none)'}`,
  });

  let parsed;
  try {
    parsed = SUGGESTION.parse(JSON.parse(text.replace(/```json|```/g, '').trim()));
  } catch {
    return 0; // malformed → skip rather than pollute the inbox
  }

  // Dedup guards (red-team M9: auto-distill without dedup grows verified_queries
  // unbounded). Skip a verified_query whose SQL already exists (as a stored verified
  // query or an already-pending suggestion), and skip a glossary term already stored.
  const existingVerifiedSql = new Set(
    (await db.select({ sql: verifiedQueries.sql }).from(verifiedQueries).where(eq(verifiedQueries.connectionId, session.connectionId))).map((v) => v.sql.replace(/\s+/g, ' ').trim().toLowerCase()),
  );
  const pending = await db.select({ kind: knowledgeSuggestions.kind, payload: knowledgeSuggestions.payload })
    .from(knowledgeSuggestions).where(and(eq(knowledgeSuggestions.connectionId, session.connectionId), eq(knowledgeSuggestions.status, 'pending')));
  for (const p of pending) {
    if (p.kind === 'verified_query' && (p.payload as any)?.sql) existingVerifiedSql.add(String((p.payload as any).sql).replace(/\s+/g, ' ').trim().toLowerCase());
  }
  const existingGlossary = new Set(
    (await db.select({ term: glossaryTerms.term }).from(glossaryTerms).where(eq(glossaryTerms.connectionId, session.connectionId))).map((g) => g.term.toLowerCase()),
  );

  let created = 0;
  for (const s of parsed.suggestions) {
    const p = s.payload as Record<string, unknown>;
    if (s.kind === 'verified_query' && p.sql) {
      const norm = String(p.sql).replace(/\s+/g, ' ').trim().toLowerCase();
      if (existingVerifiedSql.has(norm)) continue; // dedup
      existingVerifiedSql.add(norm);
    }
    if (s.kind === 'glossary' && p.term && existingGlossary.has(String(p.term).toLowerCase())) continue; // dedup
    await db.insert(knowledgeSuggestions).values({
      connectionId: session.connectionId,
      kind: s.kind,
      payload: { ...s.payload, confidence: s.confidence },
      reason: s.reason,
      sourceSessionId: sessionId,
      status: 'pending',
    });
    created++;
  }
  return created;
}

/**
 * P5f — living maintenance: distill a session into best-practice suggestions, but
 * ONLY when it actually succeeded (≥1 query ran ok), and dedup so repeated questions
 * don't flood the inbox. Inbox-gated (never auto-applies). Called after a chat turn.
 * Per the P5b spike, few-shot value is narrow (domain-convention queries), so this
 * is opportunistic, not aggressive — the human still confirms what enters context.
 */
export async function distillOnSuccess(sessionId: string): Promise<number> {
  const runs = await db.select().from(queryRuns).where(and(eq(queryRuns.sessionId, sessionId), eq(queryRuns.status, 'ok')));
  if (runs.length === 0) return 0; // nothing succeeded → nothing to distill
  return mineSession(sessionId);
}

export async function listSuggestions(connectionId: string, status = 'pending') {
  return db.select().from(knowledgeSuggestions)
    .where(and(eq(knowledgeSuggestions.connectionId, connectionId), eq(knowledgeSuggestions.status, status)));
}

/** Accept a suggestion — writes it into the real context store, marks accepted. */
export async function acceptSuggestion(id: string, overridePayload?: Record<string, unknown>) {
  const [sug] = await db.select().from(knowledgeSuggestions).where(eq(knowledgeSuggestions.id, id));
  if (!sug) throw new Error('suggestion not found');
  const p = { ...sug.payload, ...overridePayload };
  const cid = sug.connectionId;
  // Reject payloads missing required fields rather than coercing undefined →
  // the string "undefined" into the context store, which would poison the moat
  // (code-review M3). A human clicked Accept, but the data may still be malformed.
  const need = (k: string) => { const v = p[k]; if (v == null || String(v).trim() === '') throw new Error(`suggestion payload missing "${k}"`); return String(v); };

  switch (sug.kind) {
    case 'glossary':
      await addGlossaryTerm({ connectionId: cid, term: need('term'), definition: need('definition'), sqlMapping: asText(p.sqlMapping), synonyms: Array.isArray(p.synonyms) ? p.synonyms.map(String) : undefined });
      break;
    case 'table_annotation':
      await upsertTableAnnotation({ connectionId: cid, tableName: need('tableName'), description: asText(p.description), businessAlias: asText(p.businessAlias) });
      break;
    case 'column_annotation':
      await upsertColumnAnnotation({ connectionId: cid, tableName: need('tableName'), columnName: need('columnName'), description: asText(p.description), businessAlias: asText(p.businessAlias), isSensitive: Boolean(p.isSensitive) });
      break;
    case 'verified_query':
      await addVerifiedQuery({ connectionId: cid, question: need('question'), sql: need('sql') });
      break;
    case 'relationship':
      await addManualRelationship({ connectionId: cid, fromTable: need('fromTable'), fromColumn: need('fromColumn'), toTable: need('toTable'), toColumn: need('toColumn'), note: asText(p.note) });
      break;
  }
  await db.update(knowledgeSuggestions).set({ status: 'accepted' }).where(eq(knowledgeSuggestions.id, id));
}

export async function rejectSuggestion(id: string) {
  await db.update(knowledgeSuggestions).set({ status: 'rejected' }).where(eq(knowledgeSuggestions.id, id));
}
