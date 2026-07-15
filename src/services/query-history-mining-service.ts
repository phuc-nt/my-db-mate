/**
 * Mine a database's query history into inbox suggestions (verified queries +
 * relationships) the user approves. Inbox-gated — nothing is auto-applied.
 *
 * This file holds the PURE core (parse / filter / parametrize / rank / JOIN-edge
 * extraction). Source readers (pg_stat_statements, digest, paste) and the
 * suggestion orchestrator live alongside in later phases.
 *
 * Privacy: literals are parametrized (`WHERE x = 'v'` → `WHERE x = ?`) before a
 * query is ever stored or shown to the model, so pasted logs don't carry PII into
 * the context store.
 */
import pkg from 'node-sql-parser';
const { Parser } = pkg;
import { assertNotBigQuery, type ConnectionProvider, type Dialect } from './connection-providers/provider-interface';
import { PARSER_DIALECT, normalizeSqlForDedup } from './safety/safety-service';

export interface JoinEdge {
  fromTable: string;
  fromColumn: string;
  toTable: string;
  toColumn: string;
}

export interface MinedQuery {
  /** Parametrized SQL (literals → placeholders). Safe to store / show the model. */
  normalizedSql: string;
  /** Key for dedup comparison across paths. */
  dedupKey: string;
  tables: string[];
  joinEdges: JoinEdge[];
  score: number;
  rawCount: number;
}

const parser = new Parser();

/** Schema/db names whose tables are engine internals, never useful context. */
const NOISE_SCHEMAS = new Set(['pg_catalog', 'information_schema', 'performance_schema', 'mysql', 'sys', 'pg_toast']);

/** node-sql-parser stores a column ref as { expr: { value } } (or a bare string in
 *  some dialects). Normalize to the plain column name. */
function colName(c: unknown): string | undefined {
  if (typeof c === 'string') return c;
  const v = (c as { expr?: { value?: unknown } } | undefined)?.expr?.value;
  return typeof v === 'string' ? v : undefined;
}

/** Replace string/number literals with `?` in the raw SQL, outside quoted
 *  identifiers. AST-based rewrite is unreliable across dialects (sqlify drifts),
 *  so we tokenize: single-quoted strings and standalone numbers become `?`.
 *  Identifiers ("..." / [...] / `...`) and placeholders ($1, ?) are left intact. */
export function parametrizeLiterals(sql: string): string {
  let out = '';
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const ch = sql[i];
    // Optional string-literal prefix (E'', x'', b'', n'') → strip with the literal.
    if (/[ExXbBnN]/.test(ch) && sql[i + 1] === "'" && !/[A-Za-z0-9_$]/.test(out[out.length - 1] ?? ' ')) {
      i++; // skip prefix, fall through to the quote handler below
    }
    // Single-quoted string literal → one placeholder. Honors both '' and \'
    // escapes (\' is the MySQL default and appears in PG E'' strings).
    if (sql[i] === "'") {
      i++;
      while (i < n) {
        if (sql[i] === '\\') { i += 2; continue; }                     // backslash escape
        if (sql[i] === "'" && sql[i + 1] === "'") { i += 2; continue; } // doubled ''
        if (sql[i] === "'") { i++; break; }
        i++;
      }
      out += '?';
      continue;
    }
    // Dollar-quoted string ($$...$$ or $tag$...$tag$, Postgres) → one placeholder.
    if (ch === '$') {
      const tagMatch = sql.slice(i).match(/^\$([A-Za-z_]\w*)?\$/);
      if (tagMatch) {
        const tag = tagMatch[0];
        const end = sql.indexOf(tag, i + tag.length);
        i = end === -1 ? n : end + tag.length;
        out += '?';
        continue;
      }
    }
    // Quoted identifiers — copy verbatim (they are names, not values).
    if (ch === '"' || ch === '`' || ch === '[') {
      const close = ch === '[' ? ']' : ch;
      out += ch; i++;
      while (i < n) { out += sql[i]; if (sql[i] === close) { i++; break; } i++; }
      continue;
    }
    // Line / block comments — copy verbatim (denylist screening already ran).
    if (ch === '-' && sql[i + 1] === '-') { while (i < n && sql[i] !== '\n') { out += sql[i++]; } continue; }
    if (ch === '/' && sql[i + 1] === '*') { out += '/*'; i += 2; while (i < n && !(sql[i] === '*' && sql[i + 1] === '/')) out += sql[i++]; out += '*/'; i += 2; continue; }
    // A numeric literal that is a standalone value (preceded by a non-identifier
    // char) → placeholder. Avoids touching identifiers like `col2` or `t1`.
    if (/[0-9]/.test(ch) && !/[A-Za-z0-9_$]/.test(out[out.length - 1] ?? ' ')) {
      while (i < n && /[0-9.eE+-]/.test(sql[i])) i++;
      out += '?';
      continue;
    }
    out += ch; i++;
  }
  return out;
}

/** Resolve a `SELECT`'s FROM/JOIN clause into alias → base-table-name. Values
 *  that come from a subquery/derived table map to null (not a base table). */
function aliasMap(stmt: Record<string, unknown>): Map<string, string | null> {
  const map = new Map<string, string | null>();
  const from = stmt.from as unknown[] | undefined;
  if (!Array.isArray(from)) return map;
  for (const f of from) {
    const item = f as { table?: string; as?: string; expr?: unknown };
    const alias = item.as ?? item.table;
    if (!alias) continue;
    // A plain base table has a string `table`; a derived table has `expr` set.
    map.set(alias, item.expr ? null : (item.table ?? null));
  }
  return map;
}

/** Extract simple single-column equi-join edges from a parsed SELECT. Filters out
 *  the shapes that produce false relationships (red-team H3): multi-condition
 *  joins, self-joins, same-name-both-sides, non-key columns, and endpoints that
 *  don't resolve to a base table. */
function extractJoinEdges(stmt: Record<string, unknown>): JoinEdge[] {
  const from = stmt.from as unknown[] | undefined;
  if (!Array.isArray(from)) return [];
  const alias = aliasMap(stmt);
  const edges: JoinEdge[] = [];
  const keyLike = (c: string) => /(^id$|_id$)/i.test(c);

  for (const f of from) {
    const on = (f as { on?: unknown }).on as Record<string, unknown> | undefined;
    // Only a single `a.x = b.y` condition (no AND/OR/function) — a binary_expr
    // with operator '=' and column_ref operands.
    if (!on || on.type !== 'binary_expr' || on.operator !== '=') continue;
    const l = on.left as { type?: string; table?: string; column?: unknown } | undefined;
    const r = on.right as { type?: string; table?: string; column?: unknown } | undefined;
    if (l?.type !== 'column_ref' || r?.type !== 'column_ref') continue;
    const lc = colName(l.column);
    const rc = colName(r.column);
    if (!l.table || !r.table || !lc || !rc) continue;

    const fromTable = alias.get(l.table);
    const toTable = alias.get(r.table);
    if (!fromTable || !toTable) continue;          // endpoint isn't a base table
    if (fromTable === toTable) continue;           // self-join
    if (lc.toLowerCase() === rc.toLowerCase()) continue; // shared enum/partition key
    if (!keyLike(lc) && !keyLike(rc)) continue;          // neither side key-like

    edges.push({ fromTable, fromColumn: lc, toTable, toColumn: rc });
  }
  return edges;
}

/** Parse, filter, parametrize, rank a batch of raw SQL strings. Pure — parse
 *  failures are skipped, never thrown. */
export function analyzeQueries(sqls: { sql: string; count: number }[], dialect: Dialect): MinedQuery[] {
  const seen = new Set<string>();
  const out: MinedQuery[] = [];
  for (const { sql, count } of sqls) {
    let ast: unknown;
    try {
      ast = parser.astify(sql, { database: PARSER_DIALECT[dialect] });
    } catch { continue; }
    const stmt = (Array.isArray(ast) ? ast[0] : ast) as Record<string, unknown> | undefined;
    if (!stmt || String(stmt.type).toLowerCase() !== 'select') continue;

    // Table list; skip engine-internal catalog queries (the schema is in `db`).
    const from = stmt.from as { table?: string; db?: string }[] | undefined;
    const tables = Array.isArray(from) ? from.map((f) => f.table).filter((t): t is string => !!t) : [];
    if (tables.length === 0) continue; // SELECT 1, SELECT now() — trivial
    if (Array.isArray(from) && from.some((f) => f.db && NOISE_SCHEMAS.has(f.db.toLowerCase()))) continue;

    const hasWhere = stmt.where != null;
    const hasGroup = stmt.groupby != null;
    const joinEdges = extractJoinEdges(stmt);
    const nJoins = Array.isArray(from) ? from.filter((f) => (f as { join?: string }).join).length : 0;

    // Trivial single-table scan with no filter → not worth curating.
    if (tables.length === 1 && !hasWhere && !hasGroup && nJoins === 0) continue;

    const normalizedSql = parametrizeLiterals(sql).trim();
    const dedupKey = normalizeSqlForDedup(normalizedSql);
    if (seen.has(dedupKey)) continue;
    seen.add(dedupKey);

    const score =
      2 * Math.log(count + 1) +
      1.5 * tables.length +
      2 * nJoins +
      (hasWhere ? 1 : 0) +
      (hasGroup ? 1 : 0);

    out.push({ normalizedSql, dedupKey, tables, joinEdges, score, rawCount: count });
  }
  out.sort((a, b) => b.score - a.score);
  return out;
}

// ---------------------------------------------------------------------------
// Source readers — turn a live DB's stats view or a pasted log into raw SQL rows.
// ---------------------------------------------------------------------------

export interface QueryLogResult {
  /** Raw SQL rows to feed analyzeQueries. Empty when unavailable. */
  rows: { sql: string; count: number }[];
  /** false when the auto-source isn't available for this engine/config. */
  available: boolean;
  /** User-facing guidance when unavailable (how to enable, or use paste). */
  hint?: string;
  /** Count of digest rows dropped because they were truncated (MySQL). */
  truncated?: number;
}

const MYSQL_TRUNCATED = /\.\.\.\s*$/; // performance_schema digest tail marker

/** Read the engine's query-statistics view through the read-only provider.
 *  Direct executeReadOnly (bounded app-internal read) — the source queries are
 *  plain SELECTs and are not blocked by the safety layer. */
export async function fetchQueryLog(provider: ConnectionProvider): Promise<QueryLogResult> {
  if (provider.dialect === 'bigquery') {
    assertNotBigQuery(provider, 'Query-history mining');
  }
  if (provider.dialect === 'postgres') {
    try {
      const res = await provider.executeReadOnly(
        `SELECT query, calls FROM pg_stat_statements WHERE query NOT ILIKE '%pg_stat_statements%' ORDER BY calls DESC LIMIT 500`,
      );
      const rows = res.rows.map((r) => ({ sql: String(r[0]), count: Number(r[1]) || 1 }));
      if (rows.length === 0) {
        return { rows, available: true, hint: 'pg_stat_statements is enabled but shows no queries visible to this user (a non-superuser sees only its own). Run some queries first, or paste a log below.' };
      }
      return { rows, available: true };
    } catch {
      return { rows: [], available: false, hint: 'pg_stat_statements is not enabled. Add it to shared_preload_libraries and run CREATE EXTENSION pg_stat_statements — or paste a query log below.' };
    }
  }
  if (provider.dialect === 'mysql') {
    try {
      const res = await provider.executeReadOnly(
        `SELECT DIGEST_TEXT, COUNT_STAR FROM performance_schema.events_statements_summary_by_digest WHERE DIGEST_TEXT LIKE 'SELECT%' ORDER BY COUNT_STAR DESC LIMIT 500`,
      );
      let truncated = 0;
      const rows: { sql: string; count: number }[] = [];
      for (const r of res.rows) {
        const sql = String(r[0]);
        // Digest text is capped at performance_schema_max_digest_length (~1024)
        // and tail-marked with '...'; those don't parse — drop and count them.
        if (MYSQL_TRUNCATED.test(sql)) { truncated++; continue; }
        rows.push({ sql, count: Number(r[1]) || 1 });
      }
      const hint = truncated > 0
        ? `${truncated} long queries were skipped (performance_schema digest truncated them). Raise performance_schema_max_digest_length or paste those queries below.`
        : undefined;
      return { rows, available: true, ...(hint ? { hint } : {}) };
    } catch {
      return { rows: [], available: false, hint: 'performance_schema is not enabled. Enable it, or paste a query log below.' };
    }
  }
  // SQLite / D1 / SQL Server: no built-in per-statement history view.
  return { rows: [], available: false, hint: `${provider.dialect} has no built-in query-history view — paste a query log below.` };
}

/** Split a pasted log / .sql text into individual statements, aware of quotes,
 *  dollar-quoting and comments so a `;` inside a string doesn't split a query.
 *  Strips MySQL slow-query-log noise lines (`# ...`, `SET timestamp=...`). */
export function parsePastedLog(text: string, maxStatements = 1000): { sql: string; count: number }[] {
  // Drop slow-query-log metadata lines before splitting.
  const cleaned = text
    .split('\n')
    .filter((line) => !/^\s*#/.test(line) && !/^\s*SET\s+timestamp\s*=/i.test(line))
    .join('\n');

  const stmts: string[] = [];
  let cur = '';
  let i = 0;
  const n = cleaned.length;
  while (i < n) {
    const ch = cleaned[i];
    if (ch === "'" || ch === '"' || ch === '`') {
      cur += ch; i++;
      while (i < n) {
        if (ch === "'" && cleaned[i] === '\\') { cur += cleaned[i] + (cleaned[i + 1] ?? ''); i += 2; continue; }
        cur += cleaned[i];
        if (cleaned[i] === ch) { i++; break; }
        i++;
      }
      continue;
    }
    if (ch === '$') { // dollar-quote $$...$$ or $tag$...$tag$
      const tagMatch = cleaned.slice(i).match(/^\$([A-Za-z_]\w*)?\$/);
      if (tagMatch) {
        const tag = tagMatch[0];
        const end = cleaned.indexOf(tag, i + tag.length);
        const stop = end === -1 ? n : end + tag.length;
        cur += cleaned.slice(i, stop);
        i = stop;
        continue;
      }
    }
    if (ch === '-' && cleaned[i + 1] === '-') { while (i < n && cleaned[i] !== '\n') cur += cleaned[i++]; continue; }
    if (ch === '/' && cleaned[i + 1] === '*') { cur += '/*'; i += 2; while (i < n && !(cleaned[i] === '*' && cleaned[i + 1] === '/')) cur += cleaned[i++]; cur += '*/'; i += 2; continue; }
    if (ch === ';') { stmts.push(cur); cur = ''; i++; continue; }
    cur += ch; i++;
  }
  if (cur.trim()) stmts.push(cur);

  return stmts
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .slice(0, maxStatements)
    .map((sql) => ({ sql, count: 1 }));
}
