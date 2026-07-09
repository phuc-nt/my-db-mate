/**
 * Execution-plan viewer service (P9-A3). Validates a query is a read-only SELECT,
 * then EXPLAINs it (plan-only, never ANALYZE) and returns the estimate + raw plan
 * text for rendering. NO index suggestions — schema-sync captures no index metadata,
 * so a CREATE INDEX hint can't know an index already exists (red-team M3, descoped).
 * Only flags a full scan.
 *
 * The VALIDATED sql (verdict.sql) is what reaches explainQuery — the multi-statement
 * rejection in validateSql is load-bearing (red-team Sec-F3).
 */
import { getConnection } from './connection-service';
import { buildProvider, type ConnectionRow } from './connection-providers/provider-factory';
import { validateSql } from './safety/safety-service';
import type { Dialect } from './connection-providers/provider-interface';

export type ExplainResult =
  | { status: 'ok'; dialect: Dialect; estimatedRows: number | null; hasFullScan: boolean; tableCount: number; raw: string | null }
  | { status: 'blocked' | 'error'; message: string };

export async function explainVisual(connectionId: string, sql: string): Promise<ExplainResult> {
  const conn = await getConnection(connectionId);
  if (!conn) return { status: 'error', message: 'Connection not found' };

  const verdict = validateSql(sql, conn.dialect as Dialect);
  if (verdict.status === 'blocked') return { status: 'blocked', message: verdict.reason };

  const provider = buildProvider(conn as unknown as ConnectionRow);
  try {
    // Pass the VALIDATED sql (not raw user input) so multi-statement normalization
    // is the string actually explained.
    const est = await provider.explainQuery(verdict.sql);
    return {
      status: 'ok',
      dialect: conn.dialect as Dialect,
      estimatedRows: est.estimatedRows,
      hasFullScan: est.hasFullScan,
      tableCount: est.tableCount,
      raw: est.raw ?? null,
    };
  } catch (e) {
    return { status: 'error', message: e instanceof Error ? e.message : String(e) };
  } finally {
    await provider.close();
  }
}
