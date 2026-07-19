/** Filters a widget's SELECT for dashboard cross-filtering by WRAPPING it as a
 *  derived table and filtering the outer query: `SELECT * FROM (<sql>) AS _cf
 *  WHERE col = value`. Wrapping (not injecting a top-level WHERE) is what makes
 *  the clicked column work on every dialect: the chart's x is usually a SELECT
 *  ALIAS of an expression (e.g. `date_trunc(...) AS month`), and standard SQL
 *  (Postgres/MySQL/MSSQL/BigQuery) forbids an alias in the inner WHERE — only
 *  SQLite is lax, which is why a SQLite-only test missed it. As a derived-table
 *  column the alias is always valid.
 *
 *  Server-only: node-sql-parser is heavy — never import from a client component.
 *  The inner SQL is still parsed to REJECT what can't be safely wrapped
 *  (multi-statement, non-SELECT, UNION/set-op) so the caller degrades to a
 *  "not filterable" badge; CTEs are fine now (they live inside the derived
 *  table). The value is escaped for the dialect (quote/backslash doubling) —
 *  the same neutralisation the AST path used — and the column is a guarded
 *  plain identifier, quoted per dialect. */
import pkg from 'node-sql-parser';
import { DIALECT_MAP, DIM_NAME } from './sql-dimension-rewrite';

const { Parser } = pkg;

/** Values come from a clicked datapoint. Strings/dates are single-quoted string
 *  literals; numbers/booleans are bare literals; null becomes `IS NULL`. A DB
 *  type error (e.g. BigQuery INT64 = '2024') is left to the executor to surface. */
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

  // Parse only to VALIDATE the inner query — reject what can't be safely wrapped.
  let ast: unknown;
  try {
    ast = parser.astify(sql, { database });
  } catch (e) {
    return { error: `cannot parse widget SQL for cross-filter: ${e instanceof Error ? e.message : e}` };
  }
  if (Array.isArray(ast) && ast.length > 1) return { error: 'multi-statement SQL not supported for cross-filter' };
  const stmt = (Array.isArray(ast) ? ast[0] : ast) as Record<string, unknown> | null;
  if (!stmt || stmt.type !== 'select') return { error: 'cross-filter requires a plain SELECT' };
  // UNION / INTERSECT / EXCEPT don't have a single stable column list to wrap.
  if (stmt.set_op != null || stmt._next != null) return { error: 'UNION/set-op SQL not supported for cross-filter' };

  const col = quoteIdent(column, dialect);
  const predicate = value === null ? `${col} IS NULL` : `${col} = ${escapeValue(value, dialect)}`;
  // Trailing semicolons would break the wrap; the validator already rejected
  // multi-statement, so a lone trailing ';' is all we can see.
  const inner = sql.trim().replace(/;\s*$/, '');
  return { sql: `SELECT * FROM (${inner}) AS _cf WHERE ${predicate}` };
}

/** Quote a (guarded, plain-identifier) column per dialect. */
function quoteIdent(column: string, dialect: string): string {
  if (dialect === 'mysql') return `\`${column}\``;
  if (dialect === 'bigquery') return `\`${column}\``;
  return `"${column}"`; // postgres/sqlite/mssql/duckdb accept double quotes
}

/** Dialects whose default string literals treat backslash as an escape char
 *  (MySQL, BigQuery), so `\'` collapses to a literal quote and the NEXT quote
 *  closes the string — quote-doubling alone leaves an injection hole there. */
const BACKSLASH_ESCAPE_DIALECTS = new Set(['mysql', 'bigquery']);

/** Render a value as a SQL literal for the outer WHERE. Numbers/booleans are
 *  bare; strings are single-quoted with escaping WE apply (the wrap is built by
 *  string concat, not sqlify): double every single quote (stops the primary
 *  breakout on every dialect); on MySQL/BigQuery — whose string literals treat
 *  `\` as an escape — double backslashes too, FIRST, so a `\'` payload can't
 *  break out. Standard-conforming dialects (PG/SQLite/MSSQL) keep a literal
 *  backslash unchanged so real values aren't corrupted. */
function escapeValue(value: string | number | boolean, dialect: string): string {
  if (typeof value === 'number') return String(value);
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  let s = String(value);
  if (BACKSLASH_ESCAPE_DIALECTS.has(dialect)) s = s.replace(/\\/g, '\\\\');
  s = s.replace(/'/g, "''");
  return `'${s}'`;
}
