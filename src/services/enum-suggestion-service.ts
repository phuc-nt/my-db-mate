/**
 * P5a — Enum-annotation accelerator. Makes the *proven* moat (human enum→meaning)
 * low-friction: scan columns → detect enum-candidates (low-cardinality, non-numeric)
 * → for each, create a PENDING column_annotation suggestion carrying the distinct
 * values (+ an optional low-confidence LLM draft meaning). The DBA edits the meaning
 * and 1-click accepts via the existing inbox (acceptSuggestion → upsertColumnAnnotation).
 *
 * Deliberately NOT auto-apply: the moat A/B test proved the LLM guesses enum meaning
 * confidently WRONG, so a guessed meaning never reaches the generation context without
 * a human confirming it. This is the whole point of the re-scope (red-team P5).
 */
import { and, eq } from 'drizzle-orm';
import { generateText } from 'ai';
import { db } from '../db/client';
import { schemaTables, schemaColumns } from '../db/schema';
import { knowledgeSuggestions, columnAnnotations } from '../db/context-schema';
import { profileColumn } from './profiling-service';
import { getModel } from './llm-service';

const DEFAULT_MAX_COLUMNS = 60;
const MIN_ENUM_DISTINCT = 2;
const MAX_ENUM_DISTINCT = 25; // above this it's not really an enum

/** Heuristic: a value looks numeric (so a low-cardinality numeric column like a
 *  rating 1-5 is still enum-ish, but pure ids/measures are excluded elsewhere). */
function isNumericLike(v: unknown): boolean {
  if (v == null) return false;
  const s = String(v).trim();
  return s !== '' && !isNaN(Number(s));
}

/** Heuristic: a value looks like an opaque ID/hash/token — long and high-entropy
 *  (mixed case + digits, no spaces). Such columns (Drive file ids, UUIDs) are
 *  low-cardinality by accident, not real enums, and are noise in the inbox.
 *  Found via UAT: book_files.epub_id (32-char Drive ids) was mis-suggested. */
function looksLikeId(v: unknown): boolean {
  if (v == null) return false;
  const s = String(v).trim();
  if (s.length < 16 || /\s/.test(s)) return false;
  const hasLower = /[a-z]/.test(s);
  const hasUpper = /[A-Z]/.test(s);
  const hasDigit = /[0-9]/.test(s);
  // Long token mixing cases + digits (or a hex/base64-ish run) = an id, not an enum.
  return (hasLower && hasUpper && hasDigit) || /^[0-9a-f-]{16,}$/i.test(s) || /^[A-Za-z0-9_-]{24,}$/.test(s);
}

/** A candidate's distinct values are ID-like if MOST non-empty ones look like ids. */
function valuesLookLikeIds(values: unknown[]): boolean {
  const nonEmpty = values.filter((v) => v != null && String(v).trim() !== '');
  if (nonEmpty.length === 0) return false;
  const idCount = nonEmpty.filter(looksLikeId).length;
  return idCount >= Math.ceil(nonEmpty.length * 0.6);
}

interface Candidate { tableName: string; columnName: string; distinctCount: number; values: unknown[] }

/** Draft meanings for ALL enum candidates in ONE batched LLM call (not per-column —
 *  that was O(candidates) calls = 60s+ on a real schema). Best-effort hints. */
async function draftAllMeanings(cands: Candidate[]): Promise<Record<string, Record<string, string>>> {
  if (cands.length === 0) return {};
  try {
    const spec = cands.map((c) => `${c.tableName}.${c.columnName}: ${JSON.stringify(c.values)}`).join('\n');
    const { text } = await generateText({
      model: await getModel(),
      system:
        'You draft SHORT candidate meanings for enum code values, as hints a human will verify. ' +
        'Say "unknown" if you cannot reasonably guess. Return strict JSON keyed by "table.column": ' +
        '{"t.col":{"<value>":"<short meaning>"}}. No markdown.',
      prompt: `Enum columns and their distinct values:\n${spec}`,
    });
    return JSON.parse(text.replace(/```json|```/g, '').trim());
  } catch {
    return {};
  }
}

export interface SuggestEnumsResult {
  scanned: number;
  candidates: number;
  created: number;
}

/**
 * Scan up to `maxColumns` synced columns, detect enum candidates, and create
 * pending column_annotation suggestions. `withDrafts` adds an LLM hint per value.
 */
export async function suggestEnumAnnotations(
  connectionId: string,
  opts?: { maxColumns?: number; withDrafts?: boolean },
): Promise<SuggestEnumsResult> {
  const maxColumns = opts?.maxColumns ?? DEFAULT_MAX_COLUMNS;

  const tables = await db.select().from(schemaTables).where(eq(schemaTables.connectionId, connectionId));
  let scanned = 0;
  const cands: Candidate[] = [];

  // Phase 1: detect enum candidates (profiling only — no LLM).
  outer: for (const t of tables) {
    const cols = await db.select().from(schemaColumns).where(eq(schemaColumns.tableId, t.id));
    for (const c of cols) {
      if (scanned >= maxColumns) break outer;
      scanned++;
      const existing = await db.select({ id: columnAnnotations.id }).from(columnAnnotations)
        .where(and(eq(columnAnnotations.connectionId, connectionId), eq(columnAnnotations.tableName, t.tableName), eq(columnAnnotations.columnName, c.columnName)));
      if (existing[0]) continue;
      let prof;
      try { prof = await profileColumn(connectionId, t.tableName, c.columnName); } catch { continue; }
      const dv = prof.distinctValues ?? [];
      if (prof.distinctCount < MIN_ENUM_DISTINCT || prof.distinctCount > MAX_ENUM_DISTINCT) continue;
      if (!dv.some((v) => !isNumericLike(v))) continue;
      // Skip columns whose values are opaque ids/hashes — low-cardinality by
      // accident, not real enums (UAT: book_files.epub_id Drive ids).
      if (valuesLookLikeIds(dv)) continue;
      cands.push({ tableName: t.tableName, columnName: c.columnName, distinctCount: prof.distinctCount, values: dv });
    }
  }

  // Phase 2: optional ONE batched draft call for all candidates.
  const drafts = opts?.withDrafts ? await draftAllMeanings(cands) : {};

  // Phase 3: write pending suggestions.
  let created = 0;
  for (const c of cands) {
    const d = drafts[`${c.tableName}.${c.columnName}`];
    const valueLines = c.values.map((v) => `${String(v)}${d?.[String(v)] ? ` = ${d[String(v)]}` : ''}`).join('; ');
    const description = d
      ? `Enum column. Draft meanings (VERIFY): ${valueLines}`
      : `Enum column with values: ${c.values.map(String).join(', ')}. Add the meaning of each code.`;
    await db.insert(knowledgeSuggestions).values({
      connectionId,
      kind: 'column_annotation',
      payload: { tableName: c.tableName, columnName: c.columnName, description, distinctValues: c.values, draftMeanings: d ?? undefined, confidence: 'low' },
      reason: `enum candidate: ${c.distinctCount} distinct values`,
      status: 'pending',
    });
    created++;
  }
  return { scanned, candidates: cands.length, created };
}
