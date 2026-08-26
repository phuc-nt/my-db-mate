/** Rewrites a metric's (time, value) SQL into a driver query (time, value, dim)
 *  by appending the dimension column to SELECT + GROUP BY via the AST.
 *
 *  Server-only: node-sql-parser is heavy — never import from client components
 *  (same note as sql-lineage). Appending (not inserting) keeps positional
 *  `GROUP BY 1/2` references in the original SQL meaning what they meant.
 *
 *  The rewrite carries its own explicit LIMIT: validateSql would otherwise
 *  inject LIMIT 500, and driver rows = buckets × slices with ASC ordering —
 *  the truncation would silently drop exactly the LATEST buckets the driver
 *  math needs. Callers must treat a result that hits DRIVER_ROW_CAP as
 *  truncated/unreliable and skip the breakdown rather than report wrong numbers. */
import pkg from 'node-sql-parser';
const { Parser } = pkg;

/** node-sql-parser database keys per app dialect. Shared with the WHERE-filter
 *  rewrite. bigquery/duckdb added for cross-filtering (duckdb speaks Postgres
 *  syntax to the parser); node-sql-parser has a native BigQuery mode. */
export const DIALECT_MAP: Record<string, string> = {
  postgres: 'PostgresQL',
  mysql: 'MySQL',
  sqlite: 'Sqlite',
  mssql: 'TransactSQL',
  bigquery: 'BigQuery',
  duckdb: 'PostgresQL',
};

export const DRIVER_ROW_CAP = 10_000;

/** Column/dimension names come from user input and are spliced into the AST —
 *  only plain identifiers are allowed (no quotes, dots, spaces, or expressions). */
export const DIM_NAME = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

/** `cap` is the row ceiling the caller must check against: rows.length >= cap
 *  means the driver data may be truncated → skip the breakdown. */
export function rewriteWithDimension(sql: string, dim: string, dialect: string): { sql: string; cap: number } | { error: string } {
  if (!DIM_NAME.test(dim)) return { error: `invalid dimension name "${dim}" — use a plain column name` };
  const parser = new Parser();
  let ast: unknown;
  try {
    ast = parser.astify(sql, { database: DIALECT_MAP[dialect] ?? 'PostgresQL' });
  } catch (e) {
    return { error: `cannot parse metric SQL for dimension rewrite: ${e instanceof Error ? e.message : e}` };
  }
  if (Array.isArray(ast) && ast.length > 1) return { error: 'multi-statement SQL not supported for dimensions' };
  const stmt = (Array.isArray(ast) ? ast[0] : ast) as Record<string, unknown> | null;
  if (!stmt || stmt.type !== 'select') return { error: 'dimensions require a plain SELECT metric query' };
  // CTEs parse as type 'select' too — reject explicitly (rewriting the outer
  // select can't guarantee the dimension column is visible there).
  if (stmt.with != null) return { error: 'CTE (WITH ...) not supported for dimensions' };
  const groupby = stmt.groupby as { columns?: unknown[] } | unknown[] | null;
  const gbColumns = Array.isArray(groupby) ? groupby : groupby?.columns;
  if (!Array.isArray(gbColumns) || gbColumns.length === 0) {
    return { error: 'metric SQL must have GROUP BY to support dimensions' };
  }

  const dimRef = { type: 'column_ref', table: null, column: dim };
  (stmt.columns as unknown[]).push({ expr: dimRef, as: null });
  gbColumns.push(dimRef);

  let out: string;
  try {
    out = parser.sqlify(stmt as never, { database: DIALECT_MAP[dialect] ?? 'PostgresQL' });
  } catch (e) {
    return { error: `cannot regenerate SQL after rewrite: ${e instanceof Error ? e.message : e}` };
  }
  // Own LIMIT so validateSql doesn't inject LIMIT 500 (see module note).
  // T-SQL has no LIMIT (validateSql injects TOP 500 instead) — accept the lower
  // cap there; the cap-hit check keeps truncated drivers out of the digest.
  if (dialect === 'mssql') return { sql: out, cap: 500 };
  if (!/\blimit\s+\d+\s*$/i.test(out)) out = `${out} LIMIT ${DRIVER_ROW_CAP}`;
  return { sql: out, cap: DRIVER_ROW_CAP };
}
