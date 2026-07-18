/** Injects a `column = value` (or `column IS NULL`) predicate into a widget's
 *  SELECT for dashboard cross-filtering, via the node-sql-parser AST so the
 *  literal is escaped by sqlify rather than string-concatenated.
 *
 *  Server-only: node-sql-parser is heavy — never import from a client component
 *  (same note as sql-dimension-rewrite / sql-lineage).
 *
 *  WHERE sits before GROUP BY, so unlike the dimension rewrite this never
 *  disturbs positional `GROUP BY 1/2` references. Rejects anything it can't
 *  safely rewrite (CTE, UNION/set-op, multi-statement, non-SELECT) so the
 *  caller can degrade to a "not filterable" badge instead of running wrong SQL. */
import pkg from 'node-sql-parser';
import { DIALECT_MAP, DIM_NAME } from './sql-dimension-rewrite';

const { Parser } = pkg;

/** Values come from a clicked datapoint. Strings/dates are single-quoted string
 *  literals; numbers are numeric literals; booleans are bool literals; null
 *  becomes `IS NULL`. A DB type error (e.g. BigQuery INT64 = '2024') is left to
 *  the executor to surface — we don't guess casts. */
export type FilterValue = string | number | boolean | null;

export function rewriteWithWhereFilter(
  sql: string,
  column: string,
  value: FilterValue,
  dialect: string,
): { sql: string } | { error: string } {
  if (!DIM_NAME.test(column)) return { error: `invalid column name "${column}" — use a plain column name` };
  const database = DIALECT_MAP[dialect] ?? 'PostgresQL';
  const parser = new Parser();
  let ast: unknown;
  try {
    ast = parser.astify(sql, { database });
  } catch (e) {
    return { error: `cannot parse widget SQL for cross-filter: ${e instanceof Error ? e.message : e}` };
  }
  if (Array.isArray(ast) && ast.length > 1) return { error: 'multi-statement SQL not supported for cross-filter' };
  const stmt = (Array.isArray(ast) ? ast[0] : ast) as Record<string, unknown> | null;
  if (!stmt || stmt.type !== 'select') return { error: 'cross-filter requires a plain SELECT' };
  // CTEs parse as type 'select' too; the filtered column may not be visible in
  // the outer select, so refuse rather than silently mis-filter.
  if (stmt.with != null) return { error: 'CTE (WITH ...) not supported for cross-filter' };
  // UNION / INTERSECT / EXCEPT: node-sql-parser exposes a set-op node — refuse.
  if (stmt.set_op != null || stmt._next != null) return { error: 'UNION/set-op SQL not supported for cross-filter' };

  const colRef = { type: 'column_ref', table: null, column };
  const predicate = value === null
    ? { type: 'unary_expr', operator: 'IS NULL', expr: colRef }
    : { type: 'binary_expr', operator: '=', left: colRef, right: valueNode(value) };

  const existing = stmt.where;
  stmt.where = existing
    ? { type: 'binary_expr', operator: 'AND', left: existing, right: predicate }
    : predicate;

  try {
    const out = parser.sqlify(stmt as never, { database });
    return { sql: out };
  } catch (e) {
    return { error: `cannot rebuild cross-filtered SQL: ${e instanceof Error ? e.message : e}` };
  }
}

function valueNode(value: string | number | boolean): Record<string, unknown> {
  if (typeof value === 'number') return { type: 'number', value };
  if (typeof value === 'boolean') return { type: 'bool', value };
  // node-sql-parser's sqlify does NOT escape a raw single quote in a
  // single_quote_string node (verified across pg/mysql/sqlite/mssql/bigquery):
  // it emits `'O'Brien'` verbatim. It DOES round-trip a value that already
  // contains a doubled quote. So we double the quotes ourselves — this is the
  // escaping, not sqlify. Backslashes are left as-is (standard SQL string
  // literals don't treat `\` specially; the doubled-quote is what matters).
  return { type: 'single_quote_string', value: String(value).replace(/'/g, "''") };
}
