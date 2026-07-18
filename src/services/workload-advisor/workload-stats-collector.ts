/**
 * Workload stats collector (OLTP advisor, PG + MySQL).
 *
 * Reads the engine's own workload views to surface: query hotspots ranked by
 * TOTAL execution time (not mean — a fast query run 50k times outweighs a rare
 * slow one), index usage + index DEFINITIONS (schema-sync captures none, and the
 * advisor rules need them to know whether a candidate index already exists), and
 * table scan patterns.
 *
 * Contract (matches query-history-mining-service precedent):
 * - Reads go through `provider.executeReadOnly` directly — these are bounded,
 *   app-internal reads over system views, NOT routed through the query-executor
 *   choke point (that path would hit the risk gate's needs_confirmation on
 *   un-estimable system-view scans with no human to confirm). No audit row.
 * - Every query TEXT is parametrized in this collector before it leaves, so raw
 *   literals (a cross-role PII/secret leak surface) never reach the UI or an LLM.
 */
import type { ConnectionProvider } from '../connection-providers/provider-interface';
import { parametrizeLiterals } from '../query-history-mining-service';

/** A heavy query from the workload, text already parametrized. */
export interface WorkloadHotspot {
  sql: string;
  calls: number;
  totalMs: number;
  meanMs: number;
  rows: number;
}

/** Index usage + its definition (so rules can tell if a candidate already exists). */
export interface IndexStat {
  schema: string | null;
  table: string;
  indexName: string;
  /** Column list in index order, when derivable from the definition. */
  columns: string[];
  scans: number;
  isUnique: boolean;
  isPrimary: boolean;
  definition: string;
}

/** Table-level scan pattern — a high seq-scan ratio hints at a missing index. */
export interface TableStat {
  schema: string | null;
  table: string;
  seqScans: number;
  seqTupRead: number;
  liveRows: number | null;
}

export interface WorkloadAvailability {
  available: boolean;
  hint?: string;
  /** Postgres server_version_num (e.g. 160002) — gates EXPLAIN (GENERIC_PLAN) in phase 2. */
  pgVersionNum?: number;
}

export interface WorkloadStats {
  hotspots: WorkloadHotspot[];
  indexes: IndexStat[];
  tables: TableStat[];
  availability: WorkloadAvailability;
}

const EMPTY: Omit<WorkloadStats, 'availability'> = { hotspots: [], indexes: [], tables: [] };

export async function collectWorkloadStats(provider: ConnectionProvider): Promise<WorkloadStats> {
  if (provider.dialect === 'postgres') return collectPostgres(provider);
  if (provider.dialect === 'mysql') return collectMysql(provider);
  return {
    ...EMPTY,
    availability: { available: false, hint: `Workload analysis is not available for ${provider.dialect} connections (no query-workload statistics view). Supported: PostgreSQL, MySQL/MariaDB.` },
  };
}

const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

async function collectPostgres(provider: ConnectionProvider): Promise<WorkloadStats> {
  // Version gates the total_exec_time column name (PG13+) and GENERIC_PLAN (PG16+).
  let pgVersionNum: number | undefined;
  try {
    const v = await provider.executeReadOnly('SHOW server_version_num');
    pgVersionNum = num(v.rows[0]?.[0]) || undefined;
  } catch { /* older/permission — leave undefined, degrade below */ }
  const timeCol = pgVersionNum && pgVersionNum < 130000 ? 'total_time' : 'total_exec_time';
  const meanCol = pgVersionNum && pgVersionNum < 130000 ? 'mean_time' : 'mean_exec_time';

  let hotspots: WorkloadHotspot[];
  try {
    // Exclude the advisor's/app's own introspection over system catalogs — otherwise
    // it recommends indexes on pg_stat_user_indexes aliases, which is noise.
    const res = await provider.executeReadOnly(
      `SELECT query, calls, ${timeCol} AS total_ms, ${meanCol} AS mean_ms, rows
       FROM pg_stat_statements
       WHERE query ILIKE 'SELECT%'
         AND query NOT ILIKE '%pg_stat_statements%'
         AND query NOT ILIKE '%pg_stat_user_%'
         AND query NOT ILIKE '%pg_indexes%'
         AND query NOT ILIKE '%information_schema%'
         AND query NOT ILIKE '%__mydbmate_probe__%'
       ORDER BY ${timeCol} DESC LIMIT 100`,
    );
    hotspots = res.rows.map((r) => ({
      sql: parametrizeLiterals(String(r[0])).trim(),
      calls: num(r[1]),
      totalMs: num(r[2]),
      meanMs: num(r[3]),
      rows: num(r[4]),
    }));
  } catch {
    return {
      ...EMPTY,
      availability: {
        available: false,
        pgVersionNum,
        hint: 'pg_stat_statements is not enabled. Add it to shared_preload_libraries and run CREATE EXTENSION pg_stat_statements. (A non-superuser also only sees its own queries.)',
      },
    };
  }

  const indexes = await collectPgIndexes(provider);
  const tables = await collectPgTables(provider);
  const hint = hotspots.length === 0
    ? 'pg_stat_statements is enabled but shows no queries visible to this user (a non-superuser sees only its own). Run some queries first.'
    : undefined;
  return { hotspots, indexes, tables, availability: { available: true, pgVersionNum, ...(hint ? { hint } : {}) } };
}

async function collectPgIndexes(provider: ConnectionProvider): Promise<IndexStat[]> {
  try {
    // Join usage stats to definitions; is_unique/is_primary from pg_index.
    const res = await provider.executeReadOnly(
      `SELECT s.schemaname, s.relname, s.indexrelname, s.idx_scan,
              i.indexdef, ix.indisunique, ix.indisprimary
       FROM pg_stat_user_indexes s
       JOIN pg_indexes i ON i.schemaname = s.schemaname AND i.indexname = s.indexrelname
       JOIN pg_index ix ON ix.indexrelid = s.indexrelid
       ORDER BY s.idx_scan ASC LIMIT 500`,
    );
    return res.rows.map((r) => {
      const definition = String(r[4] ?? '');
      return {
        schema: r[0] != null ? String(r[0]) : null,
        table: String(r[1]),
        indexName: String(r[2]),
        columns: parseIndexColumns(definition),
        scans: num(r[3]),
        isUnique: r[5] === true || r[5] === 't',
        isPrimary: r[6] === true || r[6] === 't',
        definition,
      };
    });
  } catch { return []; }
}

async function collectPgTables(provider: ConnectionProvider): Promise<TableStat[]> {
  try {
    const res = await provider.executeReadOnly(
      `SELECT schemaname, relname, seq_scan, seq_tup_read, n_live_tup
       FROM pg_stat_user_tables ORDER BY seq_tup_read DESC LIMIT 200`,
    );
    return res.rows.map((r) => ({
      schema: r[0] != null ? String(r[0]) : null,
      table: String(r[1]),
      seqScans: num(r[2]),
      seqTupRead: num(r[3]),
      liveRows: r[4] != null ? num(r[4]) : null,
    }));
  } catch { return []; }
}

/** Extract the indexed column list from a Postgres `CREATE INDEX ... (a, b)` def.
 *  Best-effort: takes the first top-level parenthesized group and splits on commas
 *  outside nested parens (so `lower(x)` expression indexes stay one entry). */
export function parseIndexColumns(indexdef: string): string[] {
  const open = indexdef.indexOf('(');
  if (open < 0) return [];
  let depth = 0, end = -1;
  for (let i = open; i < indexdef.length; i++) {
    if (indexdef[i] === '(') depth++;
    else if (indexdef[i] === ')') { depth--; if (depth === 0) { end = i; break; } }
  }
  if (end < 0) return [];
  const inner = indexdef.slice(open + 1, end);
  const parts: string[] = [];
  let buf = '', d = 0;
  for (const ch of inner) {
    if (ch === '(') d++;
    else if (ch === ')') d--;
    if (ch === ',' && d === 0) { parts.push(buf); buf = ''; continue; }
    buf += ch;
  }
  parts.push(buf);
  // Strip ASC/DESC/opclass tails and surrounding quotes/whitespace.
  return parts
    .map((p) => p.trim().replace(/\s+(ASC|DESC|NULLS\s+(FIRST|LAST)).*$/i, '').trim().replace(/^"(.*)"$/, '$1'))
    .filter(Boolean);
}

async function collectMysql(provider: ConnectionProvider): Promise<WorkloadStats> {
  let hotspots: WorkloadHotspot[];
  let truncated = 0;
  try {
    // SUM_TIMER_WAIT is in picoseconds → ms = /1e9. Digest text is already
    // normalized (?-placeholders); still parametrize defensively for consistency.
    const res = await provider.executeReadOnly(
      `SELECT DIGEST_TEXT, COUNT_STAR, SUM_TIMER_WAIT, SUM_ROWS_SENT
       FROM performance_schema.events_statements_summary_by_digest
       WHERE DIGEST_TEXT LIKE 'SELECT%'
       ORDER BY SUM_TIMER_WAIT DESC LIMIT 100`,
    );
    hotspots = [];
    for (const r of res.rows) {
      const raw = String(r[0] ?? '');
      if (/\.\.\.\s*$/.test(raw)) { truncated++; continue; } // digest truncation marker
      const calls = num(r[1]);
      const totalMs = num(r[2]) / 1e9;
      hotspots.push({
        sql: parametrizeLiterals(raw).trim(),
        calls,
        totalMs,
        meanMs: calls > 0 ? totalMs / calls : 0,
        rows: num(r[3]),
      });
    }
  } catch {
    return {
      ...EMPTY,
      availability: { available: false, hint: 'performance_schema statement digest is not available (enable performance_schema and the statements_digest consumer).' },
    };
  }

  const { indexes, sysAvailable } = await collectMysqlIndexes(provider);
  const hints: string[] = [];
  if (truncated > 0) hints.push(`${truncated} long queries were skipped (performance_schema digest truncated them). Raise performance_schema_max_digest_length for full coverage.`);
  else if (hotspots.length === 0) hints.push('performance_schema has no SELECT digests yet — run some queries first.');
  if (!sysAvailable) hints.push('Unused-index detection needs the MySQL `sys` schema (sys.schema_unused_indexes) and the privilege to read it — not available here, so unused indexes are not reported.');
  // MySQL can't cross-check existing non-unused indexes, so missing-index suggestions
  // may include already-covered columns — surfaced as an honest limitation.
  hints.push('On MySQL, missing-index suggestions are heuristic (digest text can\'t be EXPLAINed for a plan, and existing covering indexes aren\'t cross-checked) — verify before creating.');
  return { hotspots, indexes, tables: [], availability: { available: true, hint: hints.join(' ') } };
}

async function collectMysqlIndexes(provider: ConnectionProvider): Promise<{ indexes: IndexStat[]; sysAvailable: boolean }> {
  const out: IndexStat[] = [];
  // Unused indexes via the sys schema (may be absent / lack privilege).
  try {
    const res = await provider.executeReadOnly(
      `SELECT object_schema, object_name, index_name FROM sys.schema_unused_indexes`,
    );
    for (const r of res.rows) {
      out.push({
        schema: r[0] != null ? String(r[0]) : null,
        table: String(r[1]),
        indexName: String(r[2]),
        columns: [],
        scans: 0,
        isUnique: false,
        isPrimary: String(r[2]).toUpperCase() === 'PRIMARY',
        definition: '',
      });
    }
    return { indexes: out, sysAvailable: true };
  } catch {
    return { indexes: out, sysAvailable: false };
  }
}
