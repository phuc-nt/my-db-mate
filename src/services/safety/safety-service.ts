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

const PARSER_DIALECT: Record<Dialect, string> = {
  postgres: 'postgresql',
  mysql: 'mysql',
  sqlite: 'sqlite',
};

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

  // Denylist screen — catches side-effecting SELECT-legal calls (RT-F1).
  const denyReason = screenDenylist(noComments, dialect);
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

  // Inject LIMIT if absent (bounds accidental huge scans).
  const hasLimit = 'limit' in stmt && stmt.limit != null;
  let finalSql = sql;
  let note: string | undefined;
  if (!hasLimit) {
    finalSql = `${sql}\nLIMIT ${DEFAULT_LIMIT}`;
    note = `LIMIT ${DEFAULT_LIMIT} injected (no explicit limit)`;
  }

  return { status: 'ok', sql: finalSql, note };
}
