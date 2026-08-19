/**
 * Table-reference extraction for governed-scope enforcement.
 *
 * This is a SECURITY primitive, not a UI nicety: every reference a statement can
 * read must appear in the result, or the scope guard fails open. It deliberately
 * does NOT reuse `extractLineage` (src/lib/sql-lineage.ts), which reads only the
 * top-level `stmt.from` and therefore misses references hidden in WHERE
 * subqueries, CTE bodies, derived tables, and UNION branches — each a complete
 * bypass — while also reporting CTE names as if they were real tables.
 *
 * Instead it builds on node-sql-parser's `tableList`, which walks the whole
 * statement. Verified against node-sql-parser 5.4.0: subquery, CTE-body,
 * derived-table, UNION, EXCEPT, and scalar-subquery references all appear.
 *
 * Parse failures return null. Callers MUST treat null as "cannot prove in scope"
 * and block — the same fail-closed stance the safety layer takes.
 */
import pkg from 'node-sql-parser';
const { Parser } = pkg;
import { PARSER_DIALECT } from '../services/safety/safety-service';
import type { Dialect } from '../services/connection-providers/provider-interface';

/** One table reference. `schemaName` is the dataset (BigQuery) or schema
 *  (Postgres/SQL Server), null when the statement left it implicit. */
export interface ScopeRef {
  schemaName: string | null;
  tableName: string;
}

/** BigQuery exposes metadata through a pseudo-schema suffix, e.g.
 *  `ds.INFORMATION_SCHEMA.TABLES` parses with schema `ds.INFORMATION_SCHEMA`.
 *  Metadata carries no row data, so scope treats it as a reference to the
 *  owning dataset rather than an unknown table. */
const INFO_SCHEMA_SUFFIX = '.information_schema';

/**
 * Split a table token that still carries qualification inside it. BigQuery
 * backtick-quoted refs collapse into a single token (`proj.ds.tbl`), and the
 * partially-quoted form (`` `proj`.`ds`.`tbl` ``) puts `proj.ds` in the schema
 * slot. Both must reduce to dataset + table, with the project dropped: scope is
 * defined per connection, and a connection is already bound to one project.
 *
 * The dot-split is BigQuery-only on purpose. `tableList` flattens its output to
 * `type::schema::table` and loses whether the source token was quoted, so on
 * other dialects a table literally NAMED `marts.secret` (legal, and quotable in
 * every engine here) would otherwise split into schema `marts` + table `secret`
 * and ride in on a grant for the `marts` dataset. Splitting only where the
 * dialect genuinely collapses qualification keeps a dotted name a name.
 */
function splitQualified(schema: string | null, table: string, splitDots: boolean): ScopeRef {
  // `proj.ds.tbl` or `ds.tbl` arriving as one token.
  if (splitDots && table.includes('.')) {
    const parts = table.split('.');
    const tableName = parts[parts.length - 1];
    const schemaName = parts.length >= 2 ? parts[parts.length - 2] : null;
    return { schemaName: schemaName ?? null, tableName };
  }
  // Schema slot may itself be `proj.ds` — keep only the last segment.
  if (splitDots && schema && schema.includes('.')) {
    const parts = schema.split('.');
    // `ds.INFORMATION_SCHEMA` — keep the dataset, mark the table as metadata.
    if (schema.toLowerCase().endsWith(INFO_SCHEMA_SUFFIX)) {
      return { schemaName: parts.slice(0, -1).pop() ?? null, tableName: `INFORMATION_SCHEMA.${table}` };
    }
    return { schemaName: parts[parts.length - 1], tableName: table };
  }
  return { schemaName: schema, tableName: table };
}

/** CTE names declared by the statement — these are local aliases, not tables,
 *  and `tableList` reports them alongside real ones. Subtracting them is safe:
 *  a CTE that shadows a real table name still leaves the tables its own body
 *  reads in the list, so nothing readable disappears. */
function cteNames(stmt: unknown): Set<string> {
  const out = new Set<string>();
  const withClause = (stmt as { with?: unknown })?.with;
  if (!Array.isArray(withClause)) return out;
  for (const w of withClause) {
    const name = (w as { name?: { value?: string } | string })?.name;
    const value = typeof name === 'string' ? name : name?.value;
    if (value) out.add(value.toLowerCase());
  }
  return out;
}

/**
 * Every table this SQL can read, or null when the statement could not be parsed.
 *
 * A statement that reads no base table at all (`SELECT 1`, `SELECT CURRENT_DATE()`)
 * returns an empty array — trivially within any scope. Only a parse failure
 * returns null, so callers can distinguish "reads nothing" from "unknown".
 */
export function extractScopeRefs(sql: string, dialect: Dialect | string): ScopeRef[] | null {
  const database = PARSER_DIALECT[dialect as Dialect] ?? 'postgresql';
  const parser = new Parser();

  let list: string[];
  let declaredCtes = new Set<string>();
  try {
    list = parser.tableList(sql, { database });
    // A second parse for the WITH clause: `tableList` alone cannot tell a CTE
    // name from a real table. A failure here is not fatal — worst case a CTE
    // name stays in the list and the caller sees an extra (blocking) ref, which
    // fails closed rather than open.
    try {
      const ast = parser.astify(sql, { database });
      declaredCtes = cteNames(Array.isArray(ast) ? ast[0] : ast);
    } catch {
      declaredCtes = new Set();
    }
  } catch {
    return null;
  }

  const refs: ScopeRef[] = [];
  const seen = new Set<string>();
  for (const entry of list) {
    // Format: `type::schema::table`, schema literally "null" when absent.
    const parts = entry.split('::');
    if (parts.length < 3) continue;
    const rawSchema = parts[1] === 'null' ? null : parts[1];
    const rawTable = parts.slice(2).join('::');
    if (!rawTable) continue;

    const ref = splitQualified(rawSchema, rawTable, database === 'bigquery');
    // Drop CTE self-references (only when unqualified — a schema-qualified name
    // is always a real table, never a CTE).
    if (!ref.schemaName && declaredCtes.has(ref.tableName.toLowerCase())) continue;

    const key = `${(ref.schemaName ?? '').toLowerCase()}.${ref.tableName.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    refs.push(ref);
  }
  return refs;
}
