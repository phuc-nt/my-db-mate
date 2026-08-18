/**
 * Virtual-view expansion: rewrite a query that names a governed view into one
 * the warehouse can run, by inlining the view's SELECT as a CTE.
 *
 * This exists so a curated datamart can be defined inside my-db-mate without
 * write access to the warehouse. `SELECT * FROM doanh_thu_thang` becomes
 * `WITH doanh_thu_thang AS (<curated SQL>) SELECT * FROM doanh_thu_thang`,
 * which every engine here understands and which needs no DDL.
 *
 * Kept pure and separate from the service so the rewrite — the part that can
 * silently change what a query MEANS — is testable on its own. Two rules govern
 * every decision below:
 *
 *   1. Expansion happens BEFORE the safety, scope, and cost guards, so those
 *      guards always inspect the SQL that will really run. A view can therefore
 *      never be a way to smuggle a forbidden table or an expensive scan past
 *      them — inlining puts the real tables in plain sight.
 *   2. When the rewrite cannot be proven correct, it refuses. A wrong rewrite
 *      is worse than no rewrite: it would answer a question the user did not
 *      ask, with numbers that look authoritative.
 */
import pkg from 'node-sql-parser';
const { Parser } = pkg;
import { PARSER_DIALECT } from '../services/safety/safety-service';
import type { Dialect } from '../services/connection-providers/provider-interface';

export interface VirtualViewDef {
  name: string;
  sql: string;
}

export type ExpandResult =
  /** No view was referenced: `sql` is the original string, byte-identical. */
  | { status: 'unchanged'; sql: string }
  /** At least one view was inlined; `sql` is the rewritten statement. */
  | { status: 'expanded'; sql: string; expanded: string[] }
  /** The rewrite could not be proven safe. Callers must not execute. */
  | { status: 'blocked'; reason: string };

/**
 * Base tables the statement reads DIRECTLY, before any expansion.
 *
 * This is what `viewsOnly` needs and what the scope guard cannot supply: once a
 * view is inlined, the tables inside its definition look exactly like tables the
 * caller typed. Asking the question before the rewrite is the only point where
 * "the curated view reads mart_orders" and "the caller read mart_orders" are
 * still distinguishable.
 *
 * Returns null when the statement cannot be parsed, which callers must treat as
 * "cannot prove" and refuse, matching every other guard here.
 */
export function directBaseTables(
  sql: string, views: VirtualViewDef[], dialect: Dialect,
): string[] | null {
  const parser = new Parser();
  let ast: unknown;
  try {
    ast = parser.astify(sql, { database: PARSER_DIALECT[dialect] });
  } catch {
    return null;
  }
  const viewNames = new Set(views.map((v) => v.name.toLowerCase()));
  const bound = cteNames(ast);
  const out = new Set<string>();
  for (const ref of allTableRefs(ast)) {
    const bare = ref.includes('.') ? ref.slice(ref.lastIndexOf('.') + 1) : ref;
    // A CTE is defined in the statement itself, and a governed view is the
    // curated layer — neither is a raw base table.
    if (bound.has(bare) || viewNames.has(bare)) continue;
    out.add(ref);
  }
  return [...out];
}

/** Every table reference, qualified or not, lowercased. */
function allTableRefs(ast: unknown): Set<string> {
  const out = new Set<string>();
  const visit = (node: unknown) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach(visit); return; }
    const rec = node as Record<string, unknown>;
    const table = rec.table;
    if (typeof table === 'string' && !rec.expr) {
      const db = rec.db;
      out.add(typeof db === 'string' && db ? `${db}.${table}`.toLowerCase() : table.toLowerCase());
    }
    for (const v of Object.values(rec)) visit(v);
  };
  visit(ast);
  return out;
}

/** Identifier characters for a word-boundary scan. View names are validated to
 *  lowercase snake_case at save time, so this stays deliberately narrow. */
const IDENT_CHARS = /[A-Za-z0-9_]/;

/**
 * Does `name` appear in `sql` as a standalone identifier?
 *
 * Used only as a cheap pre-filter and as the fail-closed trigger when parsing
 * fails. A plain `includes` would fire on `total_revenue` inside
 * `total_revenue_by_region`, and a regex built from the name would need
 * escaping; scanning for the token with non-identifier characters on both
 * sides is both exact and injection-proof.
 */
export function mentionsIdentifier(sql: string, name: string): boolean {
  const haystack = sql.toLowerCase();
  const needle = name.toLowerCase();
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at === -1) return false;
    const before = at === 0 ? '' : haystack[at - 1];
    const after = haystack[at + needle.length] ?? '';
    // A dot before the name means it is qualified by something else
    // (`other_schema.orders`), so it is not a bare reference to our view.
    if (!IDENT_CHARS.test(before) && before !== '.' && !IDENT_CHARS.test(after)) return true;
    from = at + needle.length;
  }
}

/** CTE names already bound in the statement — these shadow a view of the same
 *  name, since SQL resolves a CTE before any schema object. */
function cteNames(ast: unknown): Set<string> {
  const out = new Set<string>();
  const visit = (node: unknown) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach(visit); return; }
    const rec = node as Record<string, unknown>;
    const withClause = rec.with;
    if (Array.isArray(withClause)) {
      for (const cte of withClause) {
        const nameNode = (cte as Record<string, unknown>)?.name as unknown;
        // node-sql-parser spells the CTE name either as a bare string or as
        // `{ value }` depending on dialect and version; accept both.
        const raw = typeof nameNode === 'string'
          ? nameNode
          : (nameNode as Record<string, unknown>)?.value;
        if (typeof raw === 'string') out.add(raw.toLowerCase());
      }
    }
    for (const v of Object.values(rec)) visit(v);
  };
  visit(ast);
  return out;
}

/** Bare table references in the statement (unqualified only — a view lives in
 *  no schema, so `analytics.orders` can never be a reference to a view). */
function bareTableRefs(ast: unknown): Set<string> {
  const out = new Set<string>();
  const visit = (node: unknown) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach(visit); return; }
    const rec = node as Record<string, unknown>;
    const table = rec.table;
    if (typeof table === 'string' && !rec.expr) {
      const db = rec.db;
      const qualified = typeof db === 'string' && db.length > 0;
      if (!qualified && !table.includes('.')) out.add(table.toLowerCase());
    }
    for (const v of Object.values(rec)) visit(v);
  };
  visit(ast);
  return out;
}

/**
 * Inline every governed view the statement references.
 *
 * `viewsOnly` marks a connection whose agent is supposed to see curated views
 * and nothing else. There, a user-supplied CTE that reuses a view's name is
 * rejected rather than honoured: it would shadow the governed definition with
 * an arbitrary one while the query still *reads* as though it used the curated
 * numbers — the exact confusion the curated layer exists to prevent. Off that
 * mode the CTE simply wins, as SQL says it should, and the scope guard still
 * inspects its body.
 */
export function expandVirtualViews(
  sql: string,
  views: VirtualViewDef[],
  dialect: Dialect,
  opts: { viewsOnly?: boolean } = {},
): ExpandResult {
  if (views.length === 0) return { status: 'unchanged', sql };

  // Cheap pre-filter: most statements name no view at all, and those must cost
  // nothing beyond this scan and leave the SQL byte-identical.
  const candidates = views.filter((v) => mentionsIdentifier(sql, v.name));
  if (candidates.length === 0) return { status: 'unchanged', sql };

  const parser = new Parser();
  let ast: unknown;
  try {
    ast = parser.astify(sql, { database: PARSER_DIALECT[dialect] });
  } catch {
    // The name appears but the statement cannot be understood. Executing it raw
    // would run whatever the warehouse thinks that name means — likely nothing,
    // possibly a real table shadowed by a view of the same name. Refuse.
    return {
      status: 'blocked',
      reason: `This query mentions the governed view ${candidates[0].name} but could not be parsed, so it cannot be expanded safely.`,
    };
  }

  const bound = cteNames(ast);
  const refs = bareTableRefs(ast);

  const toExpand: VirtualViewDef[] = [];
  for (const view of candidates) {
    const key = view.name.toLowerCase();
    if (!refs.has(key)) continue; // Mentioned in a string/comment, not read.
    if (bound.has(key)) {
      if (opts.viewsOnly) {
        return {
          status: 'blocked',
          reason: `A CTE named "${view.name}" would shadow the governed view of the same name. Rename the CTE, or use the governed view directly.`,
        };
      }
      continue; // Caller's own CTE wins; the scope guard still sees its body.
    }
    toExpand.push(view);
  }
  if (toExpand.length === 0) return { status: 'unchanged', sql };

  return {
    status: 'expanded',
    sql: prependCtes(sql, toExpand, dialect),
    expanded: toExpand.map((v) => v.name),
  };
}

/**
 * Attach the view definitions as CTEs.
 *
 * Rewriting via the AST and re-serializing would reformat the user's whole
 * query (and node-sql-parser's output is not always round-trip faithful), so
 * the statement text is left exactly as written and the definitions are placed
 * in front of it. A statement that already opens with WITH has its list
 * extended rather than nested, which keeps one flat, readable CTE chain.
 */
function prependCtes(sql: string, views: VirtualViewDef[], dialect: Dialect): string {
  const defs = views.map((v) => `${quoteName(v.name, dialect)} AS (\n${stripTrailingSemicolon(v.sql)}\n)`);
  const trimmed = sql.trimStart();
  const leading = sql.slice(0, sql.length - trimmed.length);
  const withMatch = /^with\s+(recursive\s+)?/i.exec(trimmed);
  if (withMatch) {
    const keyword = trimmed.slice(0, withMatch[0].length);
    const rest = trimmed.slice(withMatch[0].length);
    // Our definitions reference no CTE of the user's, so they go first and the
    // user's list follows — order inside a WITH clause does not bind anyway.
    return `${leading}${keyword}${defs.join(',\n')},\n${rest}`;
  }
  return `${leading}WITH ${defs.join(',\n')}\n${trimmed}`;
}

function stripTrailingSemicolon(sql: string): string {
  return sql.trim().replace(/;+\s*$/, '');
}

/** View names are validated to lowercase snake_case at save time, so quoting is
 *  only about avoiding collisions with reserved words. */
function quoteName(name: string, dialect: Dialect): string {
  if (dialect === 'mysql') return `\`${name}\``;
  if (dialect === 'bigquery') return `\`${name}\``;
  return `"${name}"`;
}
