/**
 * Starter questions for a fresh chat: prefer the connection's verified queries
 * (the questions a human already curated), fall back to safe heuristics derived
 * from schema metadata (largest table, a time column). No LLM.
 */
import { and, eq, desc } from 'drizzle-orm';
import { db } from '../db/client';
import { verifiedQueries } from '../db/context-schema';
import { schemaTables, schemaColumns } from '../db/schema';

export async function getStarterQuestions(connectionId: string, max = 4): Promise<string[]> {
  const out: string[] = [];

  // 1. Verified queries — real curated questions. Exclude bookmarks (whose
  //    `question` is a saved-query NAME, not a question) and disabled ones.
  const verified = await db
    .select({ question: verifiedQueries.question })
    .from(verifiedQueries)
    .where(and(eq(verifiedQueries.connectionId, connectionId), eq(verifiedQueries.isDisabled, false), eq(verifiedQueries.isBookmark, false)))
    .limit(max);
  for (const v of verified) if (v.question?.trim()) out.push(v.question.trim());

  if (out.length >= max) return out.slice(0, max);

  // 2. Heuristic fallbacks from schema metadata only (no profiling, no LLM).
  const tables = await db
    .select({ name: schemaTables.tableName, rows: schemaTables.rowCount })
    .from(schemaTables)
    .where(eq(schemaTables.connectionId, connectionId))
    .orderBy(desc(schemaTables.rowCount))
    .limit(3);

  if (tables[0]) out.push(`How many rows are in ${tables[0].name}?`);

  // A table with a date/timestamp column → a trend question (type is known from schema).
  for (const t of tables) {
    if (out.length >= max) break;
    const [tRow] = await db.select({ id: schemaTables.id }).from(schemaTables)
      .where(and(eq(schemaTables.connectionId, connectionId), eq(schemaTables.tableName, t.name)));
    if (!tRow) continue;
    const timeCol = await db.select({ name: schemaColumns.columnName, type: schemaColumns.dataType })
      .from(schemaColumns).where(eq(schemaColumns.tableId, tRow.id));
    const tc = timeCol.find((c) => /date|time|timestamp/i.test(c.type));
    if (tc) { out.push(`Show ${t.name} counts over time by ${tc.name}.`); break; }
  }

  return [...new Set(out)].slice(0, max);
}
