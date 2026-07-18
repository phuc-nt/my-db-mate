/**
 * DuckDB file provider (plan D) — analyze a local .duckdb file, a Parquet file,
 * or a folder of CSV/Parquet files as a read-only connection. Every surface
 * (chat, dashboards, metrics, anomaly…) works through this like any SQL engine.
 *
 * Security (red-team D1+D2):
 * - INGEST-THEN-LOCK: the child ingests files into real tables while external
 *   access is on, then SET enable_external_access=false + lock_configuration=true
 *   BEFORE any user SQL. After the lock, replacement scans / read_csv / read_text
 *   all fail from the ENGINE — the safety-service denylist is only defense in
 *   depth. Verified by the phase-2 spike.
 * - PATH SANDBOX: the configured path(s) must resolve INSIDE the allowlist root
 *   (DUCKDB_DATA_DIR), symlinks resolved first — a connection can't point at
 *   `/etc/passwd`. User SQL can't supply paths at all (no read_* reaches the DB).
 * - CHILD PROCESS + kill-timeout: queries run in a forked child so a runaway scan
 *   over a large file is SIGKILL'd, never pinning the app server (mirrors SQLite).
 */
import { fork } from 'node:child_process';
import { realpathSync, existsSync, statSync, readdirSync } from 'node:fs';
import { resolve, sep, basename, join, extname } from 'node:path';
import type {
  ConnectionProvider, Dialect, IntrospectedSchema, QueryResult, WritePrivilegeProbe, ExplainEstimate,
} from './provider-interface';

export type DuckDbSourceMode = 'duckdb' | 'parquet' | 'csv-dir';

export interface DuckDbFileConfig {
  mode: DuckDbSourceMode;
  /** For 'duckdb'/'parquet': the file. For 'csv-dir': the directory. */
  path: string;
}

const DEFAULT_EXEC_TIMEOUT_MS = Number(process.env.DUCKDB_EXEC_TIMEOUT_MS ?? 30_000);
/** Allowlist root — every source path must resolve inside this (self-host: the
 *  user copies data files here; docker-compose mounts it). Read lazily (not a
 *  module const) so the env var can be set at runtime/in tests. */
function dataRoot(): string {
  return process.env.DUCKDB_DATA_DIR ?? resolve(process.cwd(), 'data-files');
}

const CHILD_URL = new URL('./duckdb-exec-child.cjs', import.meta.url);

/** Resolve a path and assert it is inside the data root (symlinks resolved first,
 *  so a symlink inside the root can't escape it). Throws on any violation. */
function sandboxedRealpath(p: string): string {
  const rootReal = realpathSync(resolve(dataRoot()));
  const abs = resolve(p);
  if (!existsSync(abs)) throw new Error(`path not found: ${p}`);
  const real = realpathSync(abs);
  // Contained iff real === root or starts with root + separator.
  if (real !== rootReal && !real.startsWith(rootReal + sep)) {
    throw new Error(`path is outside the allowed data directory (${dataRoot()})`);
  }
  return real;
}

/** Sanitize a filename into a SQL-safe table identifier. */
function tableNameFromFile(filePath: string): string {
  const base = basename(filePath).replace(/\.[^.]+$/, '');
  const safe = base.replace(/[^A-Za-z0-9_]/g, '_');
  return /^[0-9]/.test(safe) ? `t_${safe}` : (safe || 'file');
}

interface ResolvedSource {
  kind: DuckDbSourceMode;
  path: string; // .duckdb file (kind 'duckdb')
  tables: { name: string; path: string }[]; // parquet/csv-dir
}

export class DuckDbFileProvider implements ConnectionProvider {
  readonly dialect: Dialect = 'duckdb';

  constructor(private readonly config: DuckDbFileConfig) {}

  /** Resolve + sandbox the configured source into child-message form. */
  private resolveSource(): ResolvedSource {
    const real = sandboxedRealpath(this.config.path);
    if (this.config.mode === 'duckdb') {
      if (!statSync(real).isFile()) throw new Error('duckdb mode expects a .duckdb file');
      return { kind: 'duckdb', path: real, tables: [] };
    }
    if (this.config.mode === 'parquet') {
      if (!statSync(real).isFile()) throw new Error('parquet mode expects a .parquet file');
      return { kind: 'parquet', path: real, tables: [{ name: tableNameFromFile(real), path: real }] };
    }
    // csv-dir: every .csv (and .parquet) directly inside the directory → one table each.
    if (!statSync(real).isDirectory()) throw new Error('csv-dir mode expects a directory');
    const entries = readdirSync(real)
      .filter((f) => ['.csv', '.parquet'].includes(extname(f).toLowerCase()))
      .map((f) => join(real, f));
    if (entries.length === 0) throw new Error('no .csv/.parquet files in the directory');
    // Each entry is inside `real` (already sandboxed), but re-check per file.
    // Each file re-sandboxed; the reader (csv vs parquet) is chosen per file by
    // extension in childSource() — a csv-dir may legitimately hold .parquet too.
    const tables = entries.map((p) => ({ name: tableNameFromFile(p), path: sandboxedRealpath(p) }));
    return { kind: 'csv-dir', path: real, tables };
  }

  async testConnection(): Promise<void> {
    // Resolve + a trivial ingest+lock+SELECT proves the file(s) load and lock.
    await this.runChild({ mode: 'query', source: this.childSource(), sql: 'SELECT 1' });
  }

  async probeWritePrivilege(): Promise<WritePrivilegeProbe> {
    // Files are opened read-only (.duckdb via ATTACH READ_ONLY; parquet/csv are
    // ingested into an in-memory instance that is discarded) — physically read-only.
    return { isReadOnly: true, detail: 'DuckDB file connection is read-only (in-memory ingest / READ_ONLY attach; filesystem locked before user SQL).' };
  }

  async introspectSchema(): Promise<IntrospectedSchema> {
    // Single locked child call returns columns AND per-table row counts — the
    // ingest happens once, so counts are cheap (no re-ingest per table).
    const res = await this.runChild({ mode: 'introspect', source: this.childSource() }) as { rows: unknown[][]; counts?: Record<string, number | null> };
    const counts = res.counts ?? {};
    // rows: [table_name, column_name, data_type]
    const columnsByTable = new Map<string, { columnName: string; dataType: string; ord: number }[]>();
    let ord = 0;
    let lastTable = '';
    for (const r of res.rows) {
      const table = String(r[0]);
      if (table !== lastTable) { ord = 0; lastTable = table; }
      const list = columnsByTable.get(table) ?? [];
      list.push({ columnName: String(r[1]), dataType: String(r[2]), ord: ord++ });
      columnsByTable.set(table, list);
    }
    const columns = [];
    const tables = [];
    for (const [tableName, cols] of columnsByTable) {
      tables.push({ schemaName: null, tableName, rowCount: counts[tableName] ?? null });
      for (const col of cols) {
        columns.push({ tableName, schemaName: null, columnName: col.columnName, dataType: col.dataType, isNullable: true, isPrimaryKey: false, ordinalPosition: col.ord });
      }
    }
    // DuckDB file sources carry no foreign-key metadata we ingest.
    return { tables, columns, foreignKeys: [] };
  }

  async executeReadOnly(sql: string, opts?: { timeoutMs?: number }): Promise<QueryResult> {
    const res = await this.runChild({ mode: 'query', source: this.childSource(), sql }, opts?.timeoutMs);
    return { columns: res.columns!, rows: res.rows!, rowCount: res.rows!.length };
  }

  async explainQuery(sql: string): Promise<ExplainEstimate> {
    try {
      const res = await this.runChild({ mode: 'query', source: this.childSource(), sql: `EXPLAIN ${sql}` });
      const plan = res.rows.map((r) => r.map(String).join(' ')).join('\n');
      // DuckDB EXPLAIN shows SEQ_SCAN for full scans.
      const hasFullScan = /SEQ_SCAN/i.test(plan);
      return { estimatedRows: null, estimatedCost: null, hasFullScan, tableCount: (plan.match(/SEQ_SCAN|SCAN/gi) ?? []).length, raw: plan };
    } catch {
      return { estimatedRows: null, estimatedCost: null, hasFullScan: false, tableCount: 0 };
    }
  }

  async close(): Promise<void> { /* no persistent handle — each query is a fresh child */ }

  /** Build the child message source (resolve + sandbox happens here, per call, so
   *  a file removed/changed after connect surfaces as a clean error). */
  private childSource(): { kind: DuckDbSourceMode; path: string; tables: { name: string; path: string; kind: 'csv' | 'parquet' }[] } {
    const s = this.resolveSource();
    return {
      kind: s.kind,
      path: s.path,
      tables: s.tables.map((t) => ({ name: t.name, path: t.path, kind: extname(t.path).toLowerCase() === '.parquet' ? 'parquet' : 'csv' })),
    };
  }

  private runChild(
    msg: { mode: 'query' | 'introspect'; source: unknown; sql?: string },
    timeoutMs = DEFAULT_EXEC_TIMEOUT_MS,
  ): Promise<{ ok: boolean; columns?: string[]; rows: unknown[][]; counts?: Record<string, number | null>; error?: string }> {
    return new Promise((resolvePromise, reject) => {
      const child = fork(CHILD_URL, { stdio: 'ignore' });
      let settled = false;
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try { child.kill('SIGKILL'); } catch { /* already gone */ }
        fn();
      };
      const timer = setTimeout(() => finish(() => reject(new Error(`DuckDB query exceeded ${timeoutMs}ms and was terminated`))), timeoutMs);
      child.on('message', (m: { ok: boolean; columns?: string[]; rows?: unknown[][]; counts?: Record<string, number | null>; error?: string }) => {
        if (m.ok) finish(() => resolvePromise({ ok: true, columns: m.columns, rows: m.rows ?? [], counts: m.counts }));
        else finish(() => reject(new Error(m.error ?? 'DuckDB child error')));
      });
      child.on('error', (e) => finish(() => reject(e)));
      child.on('exit', (code, signal) => {
        if (!settled) finish(() => reject(new Error(`DuckDB child exited early (code ${code}, signal ${signal})`)));
      });
      try {
        child.send(msg);
      } catch (e) {
        finish(() => reject(e instanceof Error ? e : new Error(String(e))));
      }
    });
  }
}
