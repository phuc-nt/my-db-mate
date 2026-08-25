/**
 * Starter questions for a fresh chat: prefer the connection's verified queries
 * (the questions a human already curated), fall back to safe heuristics derived
 * from schema metadata (largest table, a time column). No LLM.
 *
 * Every branch is bounded by the governed scope. A starter question is a
 * one-click prompt, so one naming a table the executor refuses hands the user a
 * dead button — which reads as the product being broken rather than the
 * connection being governed. Curated questions get no exemption: they carry
 * their own SQL and are checked against the same guard the executor runs, since
 * a scope can be narrowed after a question was written.
 */
import { and, eq, desc } from 'drizzle-orm';
import { db } from '@/core/db/client';
import { verifiedQueries } from '@/core/db/context-schema';
import { connections, schemaTables, schemaColumns } from '@/core/db/schema';
import { getScope, filterTablesToScope, assertSqlInScope } from './schema-scope-service';
import type { Dialect } from '@/core/connections/providers/provider-interface';

export async function getStarterQuestions(connectionId: string, max = 4): Promise<string[]> {
  const out: string[] = [];

  // 1. Verified queries — real curated questions. Exclude bookmarks (whose
  //    `question` is a saved-query NAME, not a question) and disabled ones.
  //    Curated is not the same as still-permitted: a query written before the
  //    scope was narrowed still names tables the executor now refuses. Each one
  //    carries its own SQL, so it is checked against the same guard the executor
  //    runs rather than being trusted for having been curated once.
  const verified = await db
    .select({ question: verifiedQueries.question, sql: verifiedQueries.sql })
    .from(verifiedQueries)
    .where(and(eq(verifiedQueries.connectionId, connectionId), eq(verifiedQueries.isDisabled, false), eq(verifiedQueries.isBookmark, false)))
    .limit(max);
  if (verified.length > 0) {
    const [conn] = await db.select({ dialect: connections.dialect }).from(connections).where(eq(connections.id, connectionId));
    for (const v of verified) {
      if (!v.question?.trim()) continue;
      const verdict = await assertSqlInScope({ connectionId, sql: v.sql, dialect: conn?.dialect as Dialect });
      if (verdict.status !== 'ok') continue;
      out.push(v.question.trim());
    }
  }

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
      .select({ id: schemaTables.id, tableName: schemaTables.tableName, rows: schemaTables.rowCount, schemaName: schemaTables.schemaName })
      .from(schemaTables)
      .where(eq(schemaTables.connectionId, connectionId))
      .orderBy(desc(schemaTables.rowCount)),
  );
  const tables = scopedTables.slice(0, 3);

  if (tables[0]) out.push(`How many rows are in ${tables[0].tableName}?`);

  // A table with a date/timestamp column → a trend question (type is known from schema).
  for (const t of tables) {
    if (out.length >= max) break;
    // Use the id carried down from the scoped query above. Re-resolving by bare
    // name would pick an arbitrary row when two datasets hold the same table
    // name, which on a multi-dataset connection silently drops the legitimate
    // in-scope suggestion depending on physical row order.
    const timeCol = await db.select({ name: schemaColumns.columnName, type: schemaColumns.dataType })
      .from(schemaColumns).where(eq(schemaColumns.tableId, t.id));
    const tc = timeCol.find((c) => /date|time|timestamp/i.test(c.type));
    if (tc) { out.push(`Show ${t.tableName} counts over time by ${tc.name}.`); break; }
  }

  return [...new Set(out)].slice(0, max);
}
