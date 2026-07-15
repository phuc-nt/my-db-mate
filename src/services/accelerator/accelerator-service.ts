/**
 * DuckDB accelerator routing decision + table extraction (Phase 2). Two
 * independent, conservative gates decide whether a validated SELECT is safe to
 * route through the Parquet-snapshot accelerator instead of the live driver:
 *
 *   1. `shouldAccelerate()` — connection opted in AND the query is expensive
 *      enough to be worth the snapshot round-trip.
 *   2. `extractTableNames()` — the query is a single, CTE-free SELECT whose
 *      FROM/JOIN table refs can be extracted unambiguously.
 *
 * Both must pass before `duckdb-executor-service.ts` is invoked. Anything that
 * fails either gate falls back to the original `provider.executeReadOnly()`
 * path — safer to not-accelerate than to accelerate wrong.
 */
import pkg from 'node-sql-parser';
const { Parser } = pkg;
import type { Dialect } from '../connection-providers/provider-interface';
import type { RiskAssessment } from '../risk-scoring-service';
import { PARSER_DIALECT } from '../safety/safety-service';

const MEDIUM_ROWS = 100_000;

// Table/schema names extracted from the AST are interpolated directly into a
// fresh `SELECT * FROM <table>` extract query (query-executor-service.ts) —
// this is the boundary that makes that safe. A malicious quoted identifier
// (e.g. `FROM "orders'; DROP TABLE query_runs; --"`) would otherwise survive
// AST extraction unchanged and inject into that new, unvalidated SQL string.
const PLAIN_IDENT = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

// Functions safe to accelerate: ANSI-standard aggregates/scalars that DuckDB
// implements identically to Postgres/MySQL/SQLite/T-SQL. Anything else (e.g.
// Postgres DATE_TRUNC, MySQL IFNULL, T-SQL ISNULL/GETDATE) either doesn't exist
// in DuckDB or could silently return a different value — safer to skip
// acceleration than to accelerate a query into a wrong answer.
const ANSI_FUNCTION_WHITELIST = new Set([
  'COUNT', 'SUM', 'AVG', 'MIN', 'MAX',
  'COALESCE', 'NULLIF', 'CAST',
  'UPPER', 'LOWER', 'TRIM', 'LENGTH', 'SUBSTRING', 'CONCAT', 'REPLACE',
  'ROUND', 'ABS', 'FLOOR', 'CEILING', 'CEIL', 'MOD',
  'ROW_NUMBER', 'RANK', 'DENSE_RANK',
]);

/** Collect every function/aggregate-function name referenced anywhere in the
 *  AST (SELECT list, WHERE, HAVING, ORDER BY, window frames — anywhere an
 *  expression can appear). Mirrors the generic tree-walk in `sql-lineage.ts`'s
 *  `collectColumns`, but keyed on function-call node shapes instead. */
function collectFunctionNames(node: unknown, out: Set<string>): void {
  if (!node || typeof node !== 'object') return;
  const n = node as Record<string, unknown>;
  if (n.type === 'aggr_func' && typeof n.name === 'string') {
    out.add(n.name.toUpperCase());
  } else if (n.type === 'function') {
    const nameNode = n.name as { name?: { value?: string }[] } | undefined;
    const value = nameNode?.name?.[0]?.value;
    if (value) out.add(value.toUpperCase());
  }
  for (const v of Object.values(n)) {
    if (Array.isArray(v)) v.forEach((x) => collectFunctionNames(x, out));
    else if (v && typeof v === 'object') collectFunctionNames(v, out);
  }
}

/** True when every function call in the statement is on the ANSI whitelist —
 *  the gate from Phase 2 Implementation Step 6. Call this only on a `stmt`
 *  already confirmed to be a single, CTE-free SELECT (see `planAcceleration`). */
function usesOnlyWhitelistedFunctions(stmt: unknown): boolean {
  const used = new Set<string>();
  collectFunctionNames(stmt, used);
  for (const fn of used) {
    if (!ANSI_FUNCTION_WHITELIST.has(fn)) return false;
  }
  return true;
}

export interface AcceleratableConnection {
  accelerateEnabled: boolean;
}

/** Connection has opted in AND the risk-scoring estimate crosses the same
 *  MEDIUM_ROWS threshold already used to gate the confirmation prompt — reusing
 *  the existing signal instead of inventing a second threshold. */
export function shouldAccelerate(conn: AcceleratableConnection, risk: RiskAssessment): boolean {
  if (!conn.accelerateEnabled) return false;
  const rows = risk.estimate.estimatedRows;
  if (rows != null) return rows > MEDIUM_ROWS;
  return risk.estimate.hasFullScan;
}

export interface AccelerationPlan {
  /** FROM/JOIN table refs, exactly as they must appear after `FROM ` in a
   *  fresh `SELECT * FROM <table>` extract query (schema-qualified when the
   *  original SQL was). */
  tables: string[];
}

/** Returns the accelerable table list for a single, CTE-free SELECT built only
 *  from ANSI-whitelisted functions, or an error string explaining why the SQL
 *  can't be safely accelerated (multi-statement, non-SELECT, CTE, a FROM entry
 *  that isn't a plain table, or a non-whitelisted function). Parses once and
 *  reuses the AST for both checks. Mirrors the astify/CTE-rejection pattern
 *  from `sql-dimension-rewrite.ts` — same parser, same dialect map. */
export function planAcceleration(sql: string, dialect: Dialect): AccelerationPlan | { error: string } {
  const parser = new Parser();
  let ast: unknown;
  try {
    ast = parser.astify(sql, { database: PARSER_DIALECT[dialect] });
  } catch (e) {
    return { error: `cannot parse SQL for acceleration: ${e instanceof Error ? e.message : e}` };
  }
  if (Array.isArray(ast) && ast.length > 1) return { error: 'multi-statement SQL not supported for acceleration' };
  const stmt = (Array.isArray(ast) ? ast[0] : ast) as Record<string, unknown> | null;
  if (!stmt || stmt.type !== 'select') return { error: 'acceleration requires a plain SELECT query' };
  // CTEs parse as type 'select' too — reject explicitly (a CTE's inner tables
  // aren't the query's own FROM/JOIN refs, and extracting them would silently
  // change what gets snapshotted).
  if (stmt.with != null) return { error: 'CTE (WITH ...) not supported for acceleration' };

  if (!usesOnlyWhitelistedFunctions(stmt)) {
    return { error: 'uses a function outside the ANSI whitelist for acceleration' };
  }

  // node-sql-parser puts a schema-qualifier (e.g. the `public` in `public.orders`)
  // in `db`, not `schema` — `db` is its generic name for "whatever prefixes the
  // table name", reused across dialects that don't have real cross-database refs.
  const from = stmt.from as { table?: string; db?: string; expr?: unknown }[] | null;
  if (!Array.isArray(from) || from.length === 0) return { error: 'no FROM clause to accelerate' };

  const tables: string[] = [];
  for (const f of from) {
    // A FROM entry with no `table` (subquery-in-FROM, table function, etc.)
    // can't be reduced to a snapshot-able table name.
    if (!f.table) return { error: 'FROM clause contains a subquery or expression, not a plain table' };
    // Reject anything that isn't a plain identifier before it can reach the
    // extract-query interpolation site — see PLAIN_IDENT above.
    if (!PLAIN_IDENT.test(f.table)) return { error: `unsupported table name for acceleration: ${f.table}` };
    if (f.db && !PLAIN_IDENT.test(f.db)) return { error: `unsupported schema name for acceleration: ${f.db}` };
    tables.push(f.db ? `${f.db}.${f.table}` : f.table);
  }
  return { tables: [...new Set(tables)] };
}
