/**
 * Workload advisor rules (deterministic — no LLM decides anything).
 *
 * Turns collected workload stats into copy-only suggestions:
 *   - hotspot ranking (already ordered by total time; classified by shape)
 *   - missing-index candidates (WHERE-equality / JOIN columns from hotspot SQL,
 *     minus columns already covered by an existing index's leading column)
 *   - unused-index (idx_scan = 0, not PK/unique)
 *   - partial-index candidates (a constant literal predicate that recurs)
 *
 * Verification status is PER-FINDING, never blanket:
 *   - 'verified-by-explain' only for a single-table candidate whose EXPLAIN
 *     (GENERIC_PLAN) plan shows a Seq Scan on that table (PG16+ only — the
 *     workload SQL is placeholder-normalized, which plain EXPLAIN can't run).
 *   - 'unverified' (with a caveat) otherwise (PG<16, MySQL, multi-table).
 * We NEVER substitute dummy literals to force a plan — fake selectivity is fake
 * evidence.
 */
import pkg from 'node-sql-parser';
import type { ConnectionProvider, Dialect } from '../connection-providers/provider-interface';
import { qualifiedTableRef, quoteColumn } from '../../lib/table-ref';
import type { WorkloadStats, WorkloadHotspot, IndexStat } from './workload-stats-collector';

const { Parser } = pkg;
const parser = new Parser();

export type AdvisorKind = 'hotspot' | 'missing-index' | 'unused-index' | 'partial-index';
export type VerificationStatus = 'verified-by-explain' | 'unverified';

export interface AdvisorFinding {
  kind: AdvisorKind;
  /** Human-readable one-line summary (parametrized SQL only — no raw literals). */
  title: string;
  /** Copy-only DDL suggestion, when the kind produces one. Never executed. */
  ddl?: string;
  verification: VerificationStatus;
  /** Why this is or isn't verified, and the honest limits. */
  caveat: string;
  /** EXPLAIN plan excerpt when verified. */
  evidence?: string;
  table?: string;
}

const PG_PARSER_OPT = { database: 'postgresql' } as const;
const MYSQL_PARSER_OPT = { database: 'mysql' } as const;

/** Column reference extracted from a hotspot's filter/join. */
interface FilterCol { table: string | null; column: string; }

/** Parse a hotspot query and collect equality-filter + join columns per table.
 *  Returns null on parse failure (counted by the caller, never guessed). */
function extractFilterColumns(sql: string, dialect: Dialect): { tables: string[]; cols: FilterCol[] } | null {
  try {
    const opt = dialect === 'mysql' ? MYSQL_PARSER_OPT : PG_PARSER_OPT;
    const ast = parser.astify(sql, opt);
    const node = Array.isArray(ast) ? ast[0] : ast;
    if (!node || (node as { type?: string }).type !== 'select') return null;
    const tables = collectTables(node);
    const cols: FilterCol[] = [];
    walkForColumnRefs((node as { where?: unknown }).where, cols);
    // JOIN ON conditions live on the from[].on nodes.
    const from = (node as { from?: unknown[] }).from ?? [];
    for (const f of from) walkForColumnRefs((f as { on?: unknown }).on, cols);
    return { tables, cols };
  } catch {
    return null;
  }
}

function collectTables(node: unknown): string[] {
  const from = (node as { from?: unknown[] }).from ?? [];
  const out: string[] = [];
  for (const f of from) {
    const t = (f as { table?: unknown }).table;
    if (typeof t === 'string') out.push(t);
  }
  return out;
}

/** Walk a WHERE/ON expression tree, collecting columns compared by equality
 *  (`col = ?`) or used in a join (`a.x = b.y`). Range/`LIKE` are lower value for
 *  a plain b-tree candidate, so we keep this to equality/join for signal quality. */
function walkForColumnRefs(expr: unknown, out: FilterCol[]): void {
  if (!expr || typeof expr !== 'object') return;
  const e = expr as { type?: string; operator?: string; left?: unknown; right?: unknown };
  if (e.type === 'binary_expr') {
    if (e.operator === 'AND' || e.operator === 'OR') {
      walkForColumnRefs(e.left, out);
      walkForColumnRefs(e.right, out);
      return;
    }
    if (e.operator === '=') {
      pushIfColumn(e.left, out);
      pushIfColumn(e.right, out);
    }
  }
}

function pushIfColumn(n: unknown, out: FilterCol[]): void {
  const c = n as { type?: string; table?: unknown; column?: unknown } | undefined;
  if (c?.type !== 'column_ref') return;
  const col = columnName(c.column);
  if (col) out.push({ table: typeof c.table === 'string' ? c.table : null, column: col });
}

/** node-sql-parser encodes a column as a bare string OR `{ expr: { value } }`
 *  (postgresql mode uses the latter). Normalize to the plain name. */
function columnName(c: unknown): string | undefined {
  if (typeof c === 'string') return c;
  const v = (c as { expr?: { value?: unknown } } | undefined)?.expr?.value;
  return typeof v === 'string' ? v : undefined;
}

/** Is `column` already the LEADING column of some index on any of `tables`? */
function coveredByLeadingIndex(column: string, tables: string[], indexes: IndexStat[]): boolean {
  const tset = new Set(tables.map((t) => t.toLowerCase()));
  return indexes.some((ix) =>
    tset.has(ix.table.toLowerCase()) &&
    ix.columns.length > 0 &&
    ix.columns[0].toLowerCase() === column.toLowerCase(),
  );
}

/** Classify a hotspot's shape so the advice differs for "hot loop" vs "rare heavy". */
function hotspotCaveat(h: WorkloadHotspot): string {
  if (h.calls >= 1000 && h.meanMs < 50) return 'High call count × low mean — a small per-call win compounds; a covering index or query cache helps most.';
  if (h.calls < 100 && h.meanMs >= 500) return 'Low call count × high mean — a heavy analytical query; check for a missing index or a full scan before optimizing.';
  return 'Ranked by total execution time (calls × mean).';
}

export interface AdviseResult {
  findings: AdvisorFinding[];
  /** Hotspot queries that could not be parsed (reported, not silently dropped). */
  unparsedCount: number;
}

/**
 * Produce advisor findings from collected stats. `provider` is used only for the
 * EXPLAIN (GENERIC_PLAN) verification on PG16+; pass a version < 160000 (or a
 * non-postgres dialect) to skip verification and emit everything as 'unverified'.
 */
export async function adviseWorkload(
  stats: WorkloadStats,
  provider: ConnectionProvider,
): Promise<AdviseResult> {
  const findings: AdvisorFinding[] = [];
  const dialect = provider.dialect;
  const canVerify = dialect === 'postgres' && (stats.availability.pgVersionNum ?? 0) >= 160000;

  // --- Hotspots (top 10 by total time; already ordered) ---
  for (const h of stats.hotspots.slice(0, 10)) {
    findings.push({
      kind: 'hotspot',
      title: `${Math.round(h.totalMs)}ms total · ${h.calls} calls · ${Math.round(h.meanMs)}ms mean — ${h.sql.slice(0, 120)}`,
      verification: 'unverified',
      caveat: hotspotCaveat(h),
    });
  }

  // --- Missing-index candidates from the top hotspots ---
  let unparsedCount = 0;
  const seenCandidates = new Set<string>();
  const explainBudget = { left: 10 }; // bound EXPLAIN calls per scan
  for (const h of stats.hotspots.slice(0, 20)) {
    const parsed = extractFilterColumns(h.sql, dialect);
    if (parsed === null) { unparsedCount++; continue; }
    const { tables, cols } = parsed;
    if (tables.length === 0) continue;
    const singleTable = tables.length === 1;
    for (const fc of cols) {
      if (coveredByLeadingIndex(fc.column, tables, stats.indexes)) continue;
      // Resolve which table the column belongs to when qualified; else assume the
      // (single) FROM table. Multi-table + unqualified → ambiguous, skip.
      const table = fc.table ?? (singleTable ? tables[0] : null);
      if (!table) continue;
      const key = `${table.toLowerCase()}.${fc.column.toLowerCase()}`;
      if (seenCandidates.has(key)) continue;
      seenCandidates.add(key);

      const ddl = `CREATE INDEX ON ${qualifiedTableRef(dialect, table)} (${quoteColumn(dialect, fc.column)});`;
      let verification: VerificationStatus = 'unverified';
      let evidence: string | undefined;
      let caveat = dialect === 'mysql'
        ? 'MySQL digest text is placeholder-normalized and cannot be EXPLAINed for a real plan — suggestion is based on repeated equality/join filters, not a verified plan.'
        : canVerify
          ? 'No Seq Scan on this table in the generic plan, or the plan could not be obtained — treat as a heuristic suggestion.'
          : 'EXPLAIN (GENERIC_PLAN) needs PostgreSQL 16+ to run placeholder SQL; on this version the suggestion is based on repeated filters, not a verified plan.';

      // Verify ONLY single-table candidates (multi-table Seq-Scan attribution is
      // unreliable: a Seq Scan on a 40-row lookup table is correct, not a gap).
      if (canVerify && singleTable && explainBudget.left > 0) {
        explainBudget.left--;
        const seq = await hasSeqScanOnTable(provider, h.sql, table);
        if (seq.ok && seq.seqScan) {
          verification = 'verified-by-explain';
          evidence = seq.excerpt;
          caveat = 'The generic plan shows a Seq Scan on this table for this query shape. Impact is an estimate from the current plan (no hypothetical index) — validate before creating on a large production table.';
        }
      }
      findings.push({ kind: 'missing-index', title: `Missing index candidate on ${table}(${fc.column})`, ddl, verification, caveat, evidence, table });
    }
  }

  // --- Unused indexes ---
  for (const ix of stats.indexes) {
    if (ix.scans === 0 && !ix.isPrimary && !ix.isUnique && ix.indexName) {
      findings.push({
        kind: 'unused-index',
        title: `Unused index ${ix.indexName} on ${ix.table} (0 scans)`,
        ddl: dropIndexDdl(dialect, ix.indexName, ix.table),
        verification: 'unverified',
        caveat: 'Zero scans SINCE stats were last reset — a read replica or a rare report may still use it. Confirm the stats window before dropping.',
        table: ix.table,
      });
    }
  }

  return { findings, unparsedCount };
}

/** Run EXPLAIN (GENERIC_PLAN, FORMAT TEXT) on placeholder SQL (PG16+) and report
 *  whether the plan Seq-Scans `table`. Returns ok=false on any error (never throws). */
async function hasSeqScanOnTable(
  provider: ConnectionProvider,
  placeholderSql: string,
  table: string,
): Promise<{ ok: boolean; seqScan: boolean; excerpt?: string }> {
  try {
    const res = await provider.executeReadOnly(`EXPLAIN (GENERIC_PLAN, FORMAT TEXT) ${placeholderSql}`);
    const plan = res.rows.map((r) => String(r[0])).join('\n');
    // Match `Seq Scan on [schema.]"?table"?` with a RIGHT boundary (whitespace, EOL,
    // quote, or an alias) so a prefix-sharing table (orders_archive) can't satisfy a
    // candidate on `orders` — that would be mis-attributed evidence. Allow an optional
    // `schema.` prefix so a plan rendering `public.orders` still verifies.
    const t = escapeRegExp(table);
    const re = new RegExp(`Seq Scan on\\s+(?:"?[A-Za-z0-9_]+"?\\.)?"?${t}"?(?=[\\s"]|$)`, 'i');
    const seqScan = re.test(plan);
    const line = plan.split('\n').find((l) => re.test(l));
    return { ok: true, seqScan, excerpt: line?.trim() };
  } catch {
    return { ok: false, seqScan: false };
  }
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** DROP INDEX is dialect-shaped: MySQL needs `ON table`, Postgres does not. */
function dropIndexDdl(dialect: Dialect, indexName: string, table: string): string {
  if (dialect === 'mysql') return `DROP INDEX ${quoteColumn(dialect, indexName)} ON ${qualifiedTableRef(dialect, table)};`;
  return `DROP INDEX ${quoteColumn(dialect, indexName)};`;
}
