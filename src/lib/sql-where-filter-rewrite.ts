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
    : { type: 'binary_expr', operator: '=', left: colRef, right: valueNode(value, dialect) };

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

/** Dialects whose default string literals treat backslash as an escape char
 *  (MySQL, BigQuery), so `\'` collapses to a literal quote and the NEXT quote
 *  closes the string — quote-doubling alone leaves an injection hole there. */
const BACKSLASH_ESCAPE_DIALECTS = new Set(['mysql', 'bigquery']);

function valueNode(value: string | number | boolean, dialect: string): Record<string, unknown> {
  if (typeof value === 'number') return { type: 'number', value };
  if (typeof value === 'boolean') return { type: 'bool', value };
  // node-sql-parser's sqlify emits the value verbatim inside a single_quote_string
  // node (no escaping — verified across all five parser dialects), so WE escape.
  // Double every single quote (stops the primary breakout on every dialect).
  // On MySQL/BigQuery, whose string literals ALSO treat `\` as an escape, a bare
  // `\'` would still break out, so double backslashes there too — FIRST, so the
  // quotes we add next aren't themselves re-escaped. We do NOT double backslashes
  // on the other dialects: with standard_conforming_strings (PG/SQLite/MSSQL
  // default) `\` is an ordinary character, and doubling it would corrupt a value
  // that legitimately contains a backslash.
  let s = String(value);
  if (BACKSLASH_ESCAPE_DIALECTS.has(dialect)) s = s.replace(/\\/g, '\\\\');
  s = s.replace(/'/g, "''");
  return { type: 'single_quote_string', value: s };
}
