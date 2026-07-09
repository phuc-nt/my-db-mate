/**
 * SQLite provider (better-sqlite3), opened readonly. The readonly handle is an
 * OS-level guarantee — it cannot be reverted mid-session like a Postgres/MySQL
 * transaction flag can, so SQLite is the safest of the three engines (RT-F2).
 */
import Database from 'better-sqlite3';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import type {
  ConnectionProvider,
  Dialect,
  IntrospectedSchema,
  QueryResult,
  WritePrivilegeProbe,
  ColumnInfo,
  ForeignKeyInfo,
} from './provider-interface';

export interface SqliteConfig {
  path: string;
}

/** Hard kill-timeout for a SQLite query (red-team C3). Matches PG/MySQL's 30s. */
const DEFAULT_EXEC_TIMEOUT_MS = Number(process.env.SQLITE_EXEC_TIMEOUT_MS ?? 30_000);

// Resolve the exec child script next to this module. Plain .cjs → loads with no
// transpile under both tsx scripts and the Next dev/prod server.
const CHILD_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  'sqlite-exec-child.cjs',
);

export class SqliteFileProvider implements ConnectionProvider {
  readonly dialect: Dialect = 'sqlite';
  private db: Database.Database | null = null;

  constructor(private readonly config: SqliteConfig) {}

  private handle(): Database.Database {
    if (!this.db) {
      // readonly:true → OS refuses writes at the file-handle level.
      this.db = new Database(this.config.path, { readonly: true, fileMustExist: true });
      this.db.pragma('busy_timeout = 5000');
    }
    return this.db;
  }

  async testConnection(): Promise<void> {
    this.handle().prepare('SELECT 1').get();
  }

  async probeWritePrivilege(): Promise<WritePrivilegeProbe> {
    // A readonly handle rejects writes to the DB file. Note: SQLite allows TEMP
    // tables even on a readonly connection (they live in memory), so we must probe
    // with a real schema write, not CREATE TEMP.
    try {
      this.handle().exec('CREATE TABLE __mydbmate_probe__ (x)');
      // Should never reach here with readonly:true. Clean up if it somehow did.
      try { this.handle().exec('DROP TABLE __mydbmate_probe__'); } catch { /* ignore */ }
      return { isReadOnly: false, detail: 'SQLite handle accepted a write (not readonly)' };
    } catch {
      return { isReadOnly: true, detail: 'SQLite opened readonly (OS-level, cannot be reverted)' };
    }
  }

  async introspectSchema(): Promise<IntrospectedSchema> {
    const db = this.handle();
    const tableRows = db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`,
      )
      .all() as { name: string }[];

    const columns: ColumnInfo[] = [];
    const foreignKeys: ForeignKeyInfo[] = [];

    for (const { name: tableName } of tableRows) {
      const cols = db.prepare(`PRAGMA table_info("${tableName}")`).all() as {
        cid: number;
        name: string;
        type: string;
        notnull: number;
        pk: number;
      }[];
      for (const c of cols) {
        columns.push({
          tableName,
          schemaName: null,
          columnName: c.name,
          dataType: c.type || 'unknown',
          isNullable: c.notnull === 0,
          isPrimaryKey: c.pk > 0,
          ordinalPosition: c.cid,
        });
      }
      const fks = db.prepare(`PRAGMA foreign_key_list("${tableName}")`).all() as {
        table: string;
        from: string;
        to: string;
      }[];
      for (const fk of fks) {
        foreignKeys.push({
          fromTable: tableName,
          fromColumn: fk.from,
          toTable: fk.table,
          toColumn: fk.to,
        });
      }
    }

    // Row-count estimate per table (red-team C2). SQLite has no cheap statistic,
    // so COUNT(*) once at sync time — acceptable (not per-query). Guarded so a
    // failure on one table never aborts the whole introspection.
    const tables = tableRows.map((t) => {
      let rowCount: number | null = null;
      try {
        const r = db.prepare(`SELECT COUNT(*) AS n FROM "${t.name}"`).get() as { n: number };
        rowCount = r.n;
      } catch { /* keep null */ }
      return { schemaName: null, tableName: t.name, rowCount };
    });

    return { tables, columns, foreignKeys };
  }

  /**
   * Execute a validated SELECT in a forked child process with a hard kill-timeout
   * (red-team C3). The parent never blocks on the synchronous better-sqlite3 call,
   * and a runaway scan is forcibly stopped with SIGKILL — the only mechanism that
   * actually terminates a mid-native-call query (a worker thread cannot). Fork
   * overhead is ~50ms, acceptable for the dogfood/LAN target.
   */
  async executeReadOnly(sql: string, opts?: { timeoutMs?: number }): Promise<QueryResult> {
    const timeoutMs = opts?.timeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS;
    return new Promise<QueryResult>((resolve, reject) => {
      const child = fork(CHILD_PATH, { stdio: 'ignore' });
      let settled = false;
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        // SIGKILL: a runaway synchronous query ignores SIGTERM until it returns.
        try { child.kill('SIGKILL'); } catch { /* already gone */ }
        fn();
      };
      const timer = setTimeout(
        () => finish(() => reject(new Error(`SQLite query exceeded ${timeoutMs}ms and was terminated`))),
        timeoutMs,
      );
      child.on('message', (m: { ok: boolean; columns?: string[]; rows?: unknown[][]; error?: string }) => {
        if (m.ok) finish(() => resolve({ columns: m.columns!, rows: m.rows!, rowCount: m.rows!.length }));
        else finish(() => reject(new Error(m.error ?? 'SQLite child error')));
      });
      child.on('error', (e) => finish(() => reject(e)));
      child.on('exit', (code, signal) => {
        if (!settled) finish(() => reject(new Error(`SQLite child exited early (code ${code}, signal ${signal})`)));
      });
      // send() can throw synchronously (channel closed, EMFILE) — route it through
      // finish() so the child is always killed and the promise always settles (review M-1).
      try {
        child.send({ path: this.config.path, sql });
      } catch (e) {
        finish(() => reject(e instanceof Error ? e : new Error(String(e))));
      }
    });
  }

  async explainQuery(sql: string) {
    // SQLite EXPLAIN QUERY PLAN gives no row/cost estimates — only SCAN vs SEARCH.
    const rows = this.handle().prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as { detail: string }[];
    const details = rows.map((r) => r.detail);
    const hasFullScan = details.some((d) => /\bSCAN\b/i.test(d) && !/USING (INDEX|COVERING INDEX|PRIMARY KEY)/i.test(d));
    const tableCount = new Set(details.map((d) => /(?:SCAN|SEARCH)\s+(\w+)/i.exec(d)?.[1]).filter(Boolean)).size;
    return { estimatedRows: null, estimatedCost: null, hasFullScan, tableCount, raw: details.join('\n') };
  }

  async close(): Promise<void> {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }
}
