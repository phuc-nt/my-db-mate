/**
 * Safety-service (RT F1/F2/F3/F11) — the deterministic guard between generated
 * SQL and a real database. NOT a prompt guardrail.
 *
 * Pipeline per statement:
 *   1. Parse with node-sql-parser for the dialect.
 *   2. Reject anything that is not a single SELECT (blocks writes/DDL, SET,
 *      transaction-control, ATTACH/PRAGMA, stacked statements).
 *   3. Walk the raw + parsed SQL for denylisted functions/phrases (RT-F1):
 *      side-effecting/admin/exfil calls that are SELECT-legal.
 *   4. Inject a LIMIT if the SELECT has none.
 *   5. Return a discriminated union (RT-F11) so P3 can add `needs_confirmation`
 *      without breaking the P1 agent loop.
 *
 * Parse failure is fail-closed: we still run the keyword/phrase screen and, if
 * anything looks non-SELECT or denylisted, we block. A clean-looking unparseable
 * statement is blocked too (safer to reject than to guess), and logged so the
 * false-positive rate can be measured before relaxing (RT-F3).
 */
import pkg from 'node-sql-parser';
const { Parser } = pkg;
import type { Dialect } from '../connection-providers/provider-interface';
import { FUNCTION_DENYLIST, PHRASE_DENYLIST } from './function-denylists';

export type SafetyVerdict =
  | { status: 'ok'; sql: string; note?: string }
  | { status: 'needs_confirmation'; sql: string; risk: number; reason: string } // P3
  | { status: 'blocked'; reason: string };

const DEFAULT_LIMIT = 500;

export const PARSER_DIALECT: Record<Dialect, string> = {
  postgres: 'postgresql',
  mysql: 'mysql',
  sqlite: 'sqlite',
  mssql: 'transactsql',
  // Unused at runtime — BigQuery connections never call validateSql() (Phase 3 of
  // the BigQuery connector plan owns its own cost-safety path). Verified node-sql-parser
  // 5.4.0 does accept 'bigquery' as a `database` option value, for if this ever changes.
  bigquery: 'bigquery',
  // node-sql-parser has no DuckDB grammar; postgresql is the closest superset for the
  // read-only SELECT surface we allow. DuckDB-specific syntax that postgresql can't
  // parse is REJECTED (fail-closed) rather than passed through — safer than guessing.
  duckdb: 'postgresql',
};

/** Canonical SQL form for dedup comparison — collapse whitespace, trim, lowercase,
 *  drop a trailing semicolon. Shared so every mining path keys duplicates the same
 *  way (a per-path copy would let the same query enter the moat twice). */
export function normalizeSqlForDedup(sql: string): string {
  return sql.replace(/\s+/g, ' ').replace(/;\s*$/, '').trim().toLowerCase();
}

/** Append a row cap to a SELECT that has none, in the target dialect's syntax.
 *  Postgres/MySQL/SQLite use LIMIT. SQL Server has no LIMIT, and OFFSET/FETCH
 *  needs a top-level ORDER BY (fragile with subqueries/UNION), so we wrap the
 *  whole query as a derived table with an outer `TOP (n)`: UNION-, CTE-, and
 *  ORDER-BY-safe. A WITH (CTE) query can't be wrapped directly, so for those we
 *  append OFFSET/FETCH only when the outer statement already has an ORDER BY;
 *  otherwise it's left uncapped (rare in our generated read paths). */
export function capRows(sql: string, n: number, dialect: Dialect): string {
  if (dialect !== 'mssql') return `${sql}\nLIMIT ${n}`;
  const trimmed = sql.trim().replace(/;\s*$/, '');
  const noLit = trimmed.replace(/'[^']*'/g, "''");
  const hasUnion = /\bunion\b|\bexcept\b|\bintersect\b/i.test(noLit);
  const isCte = /^with\b/i.test(noLit);

  // Plain SELECT (no set-operator, no CTE): insert TOP right after the leading
  // SELECT. Needs no ORDER BY and no named columns (unlike a derived-table wrap,
  // which rejects unnamed aggregate columns like COUNT(*)).
  if (!hasUnion && !isCte) {
    const m = trimmed.match(/^select(\s+distinct)?\s/i);
    if (m) {
      const idx = m[0].length;
      if (/^\s*top\s*[(\d]/i.test(trimmed.slice(idx))) return trimmed; // already capped
      return `${trimmed.slice(0, idx)}TOP (${n}) ${trimmed.slice(idx)}`;
    }
  }

  // UNION / set operators: wrap as a derived table with an outer TOP — UNION-safe,
  // no ORDER BY needed. The inner query's columns are already named (a UNION
  // requires matching, named-or-positional columns), so the wrap is valid.
  if (hasUnion) return `SELECT TOP (${n}) * FROM (\n${trimmed}\n) AS _capped`;

  // CTE: append OFFSET/FETCH only when the outer query already has an ORDER BY
  // (can't wrap a WITH as a subquery, and OFFSET/FETCH needs an ORDER BY).
  if (isCte) {
    return /\border\s+by\b/i.test(noLit) ? `${trimmed}\nOFFSET 0 ROWS FETCH NEXT ${n} ROWS ONLY` : trimmed;
  }
  return trimmed;
}

/** Strip string/line/block comments so denylist screening can't be evaded by them. */
function stripComments(sql: string): string {
  return sql
    .replace(/--[^\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .trim();
}

/** Whole-word token test, case-insensitive. */
function containsToken(haystack: string, token: string): boolean {
  const re = new RegExp(`\\b${token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
  return re.test(haystack);
}

function screenDenylist(sqlNoComments: string, dialect: Dialect): string | null {
  for (const fn of FUNCTION_DENYLIST[dialect]) {
    if (containsToken(sqlNoComments, fn)) {
      return `Denylisted function/keyword: ${fn}`;
    }
  }
  for (const re of PHRASE_DENYLIST[dialect]) {
    if (re.test(sqlNoComments)) {
      return `Denylisted construct: ${re.source}`;
    }
  }
  return null;
}

/** Count top-level statements to reject stacked queries even when the parser
 *  normalizes them. node-sql-parser returns an array for multiple statements. */
function isSingleStatement(ast: unknown): boolean {
  return !Array.isArray(ast) || ast.length === 1;
}

function firstStatement(ast: unknown): Record<string, unknown> {
  return (Array.isArray(ast) ? ast[0] : ast) as Record<string, unknown>;
}

/**
 * Reject data-modifying CTEs. `WITH x AS (INSERT/UPDATE/DELETE ... RETURNING)
 * SELECT ...` has top-level type 'select' yet writes on Postgres. Each WITH entry
 * carries its own statement whose type must be 'select'.
 */
function screenCteWrites(stmt: Record<string, unknown>): string | null {
  const withClause = stmt.with as unknown;
  const entries = Array.isArray(withClause)
    ? withClause
    : withClause && typeof withClause === 'object' && Array.isArray((withClause as { ctes?: unknown[] }).ctes)
      ? (withClause as { ctes: unknown[] }).ctes
      : [];
  for (const entry of entries) {
    const inner = (entry as { stmt?: { ast?: Record<string, unknown> } | Record<string, unknown> }).stmt;
    const innerAst = (inner as { ast?: Record<string, unknown> })?.ast ?? (inner as Record<string, unknown>);
    const innerType = String(innerAst?.type ?? '').toLowerCase();
    if (innerType && innerType !== 'select') {
      return `Data-modifying CTE not allowed (WITH contains ${innerType})`;
    }
  }
  return null;
}

/** Leading-keyword screen for DML/DDL — a cheap net that also catches DML hidden
 *  after `WITH ... AS (` before the AST parse runs (belt-and-suspenders to the AST walk). */
function screenDmlKeywords(noComments: string): string | null {
  if (/^\s*(insert|update|delete|merge|replace|upsert)\b/i.test(noComments)) {
    return 'Write statements are not allowed';
  }
  // DML appearing as a CTE body: `WITH ... AS ( INSERT|UPDATE|DELETE ...`
  if (/\bas\s*\(\s*(insert|update|delete|merge|replace)\b/i.test(noComments)) {
    return 'Data-modifying CTE not allowed';
  }
  return null;
}

export function validateSql(rawSql: string, dialect: Dialect): SafetyVerdict {
  const sql = rawSql.trim().replace(/;\s*$/, '');
  if (!sql) return { status: 'blocked', reason: 'Empty statement' };

  const noComments = stripComments(sql);

  // Reject obvious multi-statement even before parsing (defense in depth).
  // A lone trailing semicolon was already stripped; any remaining semicolon that
  // is not inside a string literal indicates stacked statements.
  if (/;/.test(noComments.replace(/'[^']*'/g, '').replace(/"[^"]*"/g, ''))) {
    return { status: 'blocked', reason: 'Multiple statements are not allowed' };
  }

  // Leading/CTE DML keyword screen (belt-and-suspenders to the AST CTE walk below).
  const dmlReason = screenDmlKeywords(noComments);
  if (dmlReason) return { status: 'blocked', reason: dmlReason };

  // Denylist screen — catches side-effecting SELECT-legal calls (RT-F1). Strip
  // single-quoted string literals first so common English words inside them
  // (`WHERE note LIKE '%execute%'`) don't false-positive on tokens like exec/sleep.
  // Double-quotes are left intact — they are identifiers in PG/SQL Server, and the
  // 4-part-name / SELECT-INTO phrase checks must still see quoted identifiers.
  const noLiterals = noComments.replace(/'[^']*'/g, "''");
  const denyReason = screenDenylist(noLiterals, dialect);
  if (denyReason) return { status: 'blocked', reason: denyReason };

  // AST parse + statement-type check.
  const parser = new Parser();
  let ast: unknown;
  try {
    ast = parser.astify(sql, { database: PARSER_DIALECT[dialect] });
  } catch {
    // Fail-closed (RT-F3): keyword screen already passed, but we cannot confirm
    // it is a pure SELECT, so block. Logged by the caller for FP-rate tracking.
    if (!/^\s*select\b/i.test(noComments) && !/^\s*with\b/i.test(noComments)) {
      return { status: 'blocked', reason: 'Unparseable and not a recognizable SELECT' };
    }
    return { status: 'blocked', reason: 'SQL could not be parsed for safety validation' };
  }

  if (!isSingleStatement(ast)) {
    return { status: 'blocked', reason: 'Multiple statements are not allowed' };
  }

  const stmt = firstStatement(ast);
  const type = String(stmt.type ?? '').toLowerCase();
  if (type !== 'select') {
    return { status: 'blocked', reason: `Only SELECT is allowed (got: ${type || 'unknown'})` };
  }

  // A data-modifying CTE — `WITH x AS (INSERT/UPDATE/DELETE ... RETURNING) SELECT ...`
  // — parses with top-level type 'select' but executes a write on Postgres. Walk the
  // WITH entries and reject any whose inner statement is not itself a SELECT.
  const withReason = screenCteWrites(stmt);
  if (withReason) return { status: 'blocked', reason: withReason };

  // T-SQL `SELECT ... INTO newtable` parses as type 'select' but creates+populates
  // a table (a write). The transactsql AST surfaces it as `into.expr` (a target
  // name); a plain SELECT has `into.expr` null. Block when a target is present.
  const into = stmt.into as { expr?: unknown } | undefined;
  if (into && into.expr != null) {
    return { status: 'blocked', reason: 'SELECT ... INTO creates a table (write) — not allowed' };
  }

  // Cap the row count if the SELECT has none (bounds accidental huge scans).
  // node-sql-parser represents "no LIMIT" as a non-null object with an empty
  // `value` array (not null), so a plain `!= null` check misfires — inspect the
  // value array. SQL Server uses TOP / OFFSET-FETCH instead of LIMIT.
  const limitNode = stmt.limit as { value?: unknown[] } | null | undefined;
  const hasLimit = Array.isArray(limitNode?.value) ? limitNode.value.length > 0 : limitNode != null;
  const hasMssqlCap = dialect === 'mssql' && (/\btop\s*\(/i.test(sql) || /\btop\s+\d/i.test(sql) || /\bfetch\s+next\b/i.test(sql));
  let finalSql = sql;
  let note: string | undefined;
  if (!hasLimit && !hasMssqlCap) {
    finalSql = capRows(sql, DEFAULT_LIMIT, dialect);
    note = `Row cap ${DEFAULT_LIMIT} injected (no explicit limit)`;
  }

  return { status: 'ok', sql: finalSql, note };
}
