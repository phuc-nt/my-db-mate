/**
 * What this connection has actually been asked, read from the internal audit log.
 *
 * The advisor needs evidence of real usage, and `fetchQueryLog` cannot supply it:
 * that reader asks the TARGET database for its own statement log, which BigQuery
 * refuses outright. But my-db-mate already records every statement it runs in
 * `query_runs`, so the evidence exists locally — no warehouse round trip, no cost,
 * and it works identically on every dialect.
 *
 * Only successful runs count. A blocked or errored statement says what someone
 * tried, not what the data supports, and a mart designed around failed queries
 * would institutionalize the mistake.
 */
import { and, desc, eq } from 'drizzle-orm';
import { db } from '../db/client';
import { queryRuns } from '../db/schema';
import { analyzeQueries, parametrizeLiterals, type MinedQuery } from './query-history-mining-service';
import type { Dialect } from './connection-providers/provider-interface';

/** Runs read per connection. Enough to see real patterns, bounded so a busy
 *  connection cannot push an unbounded prompt into the advisor. */
const DEFAULT_LIMIT = 500;

export interface QueryRunsMiningResult {
  /** Distinct statements, most-used first, with their join edges and tables. */
  mined: MinedQuery[];
  /** How many audit rows were read before dedup — the evidence base's real size. */
  runsRead: number;
}

/**
 * Mine this connection's own audit trail into deduped, parametrized queries.
 *
 * Statements are parametrized BEFORE counting so that the same query shape run
 * with a hundred different date literals reads as one popular pattern rather
 * than a hundred unique ones — which is the whole signal the advisor wants.
 */
export async function mineQueryRuns(
  connectionId: string,
  dialect: Dialect,
  limit: number = DEFAULT_LIMIT,
): Promise<QueryRunsMiningResult> {
  const rows = await db
    .select({ sql: queryRuns.sql })
    .from(queryRuns)
    .where(and(eq(queryRuns.connectionId, connectionId), eq(queryRuns.status, 'ok')))
    .orderBy(desc(queryRuns.createdAt))
    .limit(limit);

  const counts = new Map<string, { sql: string; count: number }>();
  for (const r of rows) {
    if (!r.sql) continue;
    const normalized = parametrizeLiterals(r.sql);
    const hit = counts.get(normalized);
    if (hit) hit.count += 1;
    else counts.set(normalized, { sql: r.sql, count: 1 });
  }

  return {
    mined: analyzeQueries([...counts.values()], dialect),
    runsRead: rows.length,
  };
}
