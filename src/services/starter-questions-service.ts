/**
 * Starter questions for a fresh chat: prefer the connection's verified queries
 * (the questions a human already curated), fall back to safe heuristics derived
 * from schema metadata (largest table, a time column). No LLM.
 */
import { and, eq, desc } from 'drizzle-orm';
import { db } from '../db/client';
import { verifiedQueries } from '../db/context-schema';
import { schemaTables, schemaColumns } from '../db/schema';
import { getScope, filterTablesToScope, isScopeActive } from './schema-scope-service';

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
  //    Bounded by the governed scope: a starter question is a one-click prompt,
  //    so suggesting an out-of-scope table hands the user a question the
  //    executor will refuse. Under `viewsOnly` even the in-scope raw tables are
  //    unreadable, so there is no safe heuristic left and the curated questions
  //    above are the only ones offered.
  const scope = await getScope(connectionId);
  if (scope?.viewsOnly) return out.slice(0, max);
  const scopedTables = filterTablesToScope(
    scope,
    await db
      .select({ tableName: schemaTables.tableName, rows: schemaTables.rowCount, schemaName: schemaTables.schemaName })
      .from(schemaTables)
      .where(eq(schemaTables.connectionId, connectionId))
      .orderBy(desc(schemaTables.rowCount)),
  );
  const tables = scopedTables.slice(0, 3);

  if (tables[0]) out.push(`How many rows are in ${tables[0].tableName}?`);

  // A table with a date/timestamp column → a trend question (type is known from schema).
  for (const t of tables) {
    if (out.length >= max) break;
    const [tRow] = await db.select({ id: schemaTables.id, schemaName: schemaTables.schemaName }).from(schemaTables)
      .where(and(eq(schemaTables.connectionId, connectionId), eq(schemaTables.tableName, t.tableName)));
    // Re-resolving by bare name can land on a same-named table in a dataset the
    // scope withholds, so re-check rather than trusting the name round-trip.
    if (!tRow) continue;
    if (isScopeActive(scope) && filterTablesToScope(scope, [{ schemaName: tRow.schemaName, tableName: t.tableName }]).length === 0) continue;
    const timeCol = await db.select({ name: schemaColumns.columnName, type: schemaColumns.dataType })
      .from(schemaColumns).where(eq(schemaColumns.tableId, tRow.id));
    const tc = timeCol.find((c) => /date|time|timestamp/i.test(c.type));
    if (tc) { out.push(`Show ${t.tableName} counts over time by ${tc.name}.`); break; }
  }

  return [...new Set(out)].slice(0, max);
}
