/**
 * Query-history mining orchestrator: reads a source, runs the pure analyzer, and
 * writes verified-query + relationship suggestions into the existing inbox. This
 * file owns the DB + LLM dependencies (kept out of the pure core so the analyzer
 * stays unit-testable without a database).
 */
import { generateText } from 'ai';
import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../db/client';
import { knowledgeSuggestions, verifiedQueries } from '../db/context-schema';
import { schemaTables, schemaForeignKeys } from '../db/schema';
import { getProvider } from './connection-service';
import { analyzeQueries, parametrizeLiterals, parsePastedLog, fetchQueryLog } from './query-history-mining-service';
import { normalizeSqlForDedup } from './safety/safety-service';

const VERIFIED_CAP = 5;   // human must review each NL↔SQL pair — keep it small
const RELATIONSHIP_CAP = 20;

function llm() {
  const openrouter = createOpenRouter({ apiKey: process.env.OPENROUTER_API_KEY! });
  return openrouter(process.env.OPENROUTER_MODEL ?? 'qwen/qwen3.7-max');
}

/** Ask the model for one NL question per query, matched back by id (never by
 *  array position — a reordered/short response would mislabel a query, poisoning
 *  the moat). Only parametrized SQL is sent. */
async function generateQuestions(items: { id: number; sql: string }[]): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  if (items.length === 0) return out;
  const list = items.map((it) => `#${it.id}: ${it.sql}`).join('\n');
  const { text } = await generateText({
    model: llm(),
    prompt:
      `For each SQL query below, write ONE short natural-language question a business user might ask that this query answers. ` +
      `Return ONLY lines in the exact form "id|question", one per query, using the given id. No preamble.\n\n${list}`,
  });
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*#?(\d+)\s*\|\s*(.+?)\s*$/);
    if (!m) continue;
    const id = Number(m[1]);
    if (items.some((it) => it.id === id) && !out.has(id)) out.set(id, m[2]);
  }
  return out;
}

export interface MineHistoryResult {
  created: number;
  skipped: number;
  source: 'pg_stat_statements' | 'performance_schema' | 'paste' | 'none';
  available: boolean;
  hint?: string;
}

/** Mine a connection's query history into pending inbox suggestions. */
export async function mineQueryHistory(connectionId: string, opts?: { pastedLog?: string }): Promise<MineHistoryResult> {
  const provider = await getProvider(connectionId);
  const dialect = provider.dialect;

  // 1. Source: paste takes precedence when provided, else auto-read.
  let rows: { sql: string; count: number }[] = [];
  let source: MineHistoryResult['source'] = 'none';
  let available = true;
  let hint: string | undefined;
  if (opts?.pastedLog?.trim()) {
    rows = parsePastedLog(opts.pastedLog);
    source = 'paste';
  } else {
    const log = await fetchQueryLog(provider);
    await provider.close();
    rows = log.rows;
    available = log.available;
    hint = log.hint;
    source = dialect === 'postgres' ? 'pg_stat_statements' : dialect === 'mysql' ? 'performance_schema' : 'none';
    if (!available) return { created: 0, skipped: 0, source, available, hint };
  }
  if (source === 'paste') await provider.close();

  const mined = analyzeQueries(rows, dialect);
  let skipped = rows.length - mined.length;

  // 2. Dedup keys: existing verified queries + all suggestion states (pending,
  //    accepted, rejected — a rejected item is a decision, don't re-surface).
  //    Compare on the PARAMETRIZED form on BOTH sides so the same query can't
  //    enter twice across the chat-distill and history-mining paths.
  const existingVerified = await db.select({ sql: verifiedQueries.sql }).from(verifiedQueries).where(eq(verifiedQueries.connectionId, connectionId));
  const priorSuggestions = await db.select({ kind: knowledgeSuggestions.kind, payload: knowledgeSuggestions.payload })
    .from(knowledgeSuggestions)
    .where(and(eq(knowledgeSuggestions.connectionId, connectionId), inArray(knowledgeSuggestions.status, ['pending', 'accepted', 'rejected'])));
  const seenSql = new Set<string>();
  for (const v of existingVerified) seenSql.add(normalizeSqlForDedup(parametrizeLiterals(v.sql)));
  const seenRel = new Set<string>();
  for (const s of priorSuggestions) {
    const p = s.payload as Record<string, unknown>;
    if (s.kind === 'verified_query' && p.sql) seenSql.add(normalizeSqlForDedup(parametrizeLiterals(String(p.sql))));
    if (s.kind === 'relationship') seenRel.add(relKey(p.fromTable, p.fromColumn, p.toTable, p.toColumn));
  }

  // Existing FKs + base-table set (relationship endpoints must be real tables).
  const fks = await db.select().from(schemaForeignKeys).where(eq(schemaForeignKeys.connectionId, connectionId));
  const fkSet = new Set(fks.map((f) => relKey(f.fromTable, f.fromColumn, f.toTable, f.toColumn)));
  const tables = await db.select({ name: schemaTables.tableName }).from(schemaTables).where(eq(schemaTables.connectionId, connectionId));
  const baseTables = new Set(tables.map((t) => t.name.toLowerCase()));

  // 3. verified_query candidates (dedup + cap), then one batched LLM call.
  const vqCandidates = mined.filter((m) => !seenSql.has(m.dedupKey)).slice(0, VERIFIED_CAP);
  const questions = await generateQuestions(vqCandidates.map((m, i) => ({ id: i, sql: m.normalizedSql })));

  let created = 0;
  for (let i = 0; i < vqCandidates.length; i++) {
    const q = questions.get(i);
    if (!q) { skipped++; continue; } // no matched question → don't poison the moat
    const m = vqCandidates[i];
    await db.insert(knowledgeSuggestions).values({
      connectionId, kind: 'verified_query',
      payload: { question: q, sql: m.normalizedSql, sourceKind: 'query_history' },
      reason: `Frequent query (${m.rawCount} call${m.rawCount === 1 ? '' : 's'}) from query history`,
      status: 'pending',
    });
    seenSql.add(m.dedupKey);
    created++;
  }

  // 4. relationship candidates — real base tables, not already an FK or suggested.
  const relEdges = mined.flatMap((m) => m.joinEdges);
  let relCreated = 0;
  for (const e of relEdges) {
    if (relCreated >= RELATIONSHIP_CAP) break;
    if (!baseTables.has(e.fromTable.toLowerCase()) || !baseTables.has(e.toTable.toLowerCase())) { skipped++; continue; }
    const key = relKey(e.fromTable, e.fromColumn, e.toTable, e.toColumn);
    if (fkSet.has(key) || seenRel.has(key)) continue; // already known / suggested
    seenRel.add(key);
    await db.insert(knowledgeSuggestions).values({
      connectionId, kind: 'relationship',
      payload: { fromTable: e.fromTable, fromColumn: e.fromColumn, toTable: e.toTable, toColumn: e.toColumn, note: 'Inferred from a repeated JOIN in query history', sourceKind: 'query_history' },
      reason: 'Repeated JOIN not declared as a foreign key',
      status: 'pending',
    });
    created++;
    relCreated++;
  }

  return { created, skipped, source, available: true, hint };
}

function relKey(ft: unknown, fc: unknown, tt: unknown, tc: unknown): string {
  return `${String(ft)}.${String(fc)}->${String(tt)}.${String(tc)}`.toLowerCase();
}
