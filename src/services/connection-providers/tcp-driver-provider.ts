/**
 * TCP-driver provider for PostgreSQL (`pg`) and MySQL/MariaDB (`mysql2`).
 *
 * Read-only enforcement (RT-F2): re-applied on EVERY connection acquire, not once
 * at init — a session flag set once leaks a read-write connection when the pool
 * grows or reconnects. Multi-statement is disabled at the driver level (RT-F1/F3).
 */
import { Pool as PgPool } from 'pg';
import mysql from 'mysql2/promise';
import type {
  ConnectionProvider,
  Dialect,
  IntrospectedSchema,
  QueryResult,
  WritePrivilegeProbe,
  ColumnInfo,
  ForeignKeyInfo,
} from './provider-interface';

export interface TcpConfig {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  /** postgres | mysql */
  dialect: Extract<Dialect, 'postgres' | 'mysql'>;
  /** SSL/TLS mode for the connection. Most managed cloud DBs (Neon, Supabase, RDS,
   *  PlanetScale, Aiven) REQUIRE TLS. 'require' turns TLS on without verifying the
   *  cert chain (common for managed providers with their own CA); undefined/'disable'
   *  = no TLS (local). Verification is intentionally relaxed — this is a data client,
   *  and the alternative is users can't connect to any cloud DB at all. */
  ssl?: 'require' | 'disable';
}

const DEFAULT_TIMEOUT_MS = 30_000;

/** Coerce a driver-returned row-count estimate (bigint comes back as a string in
 *  node-pg; MySQL TABLE_ROWS may be null/float) to a clean integer or null. Never
 *  returns NaN — the value is inserted into an integer column. */
function toRowCount(v: unknown): number | null {
  if (v == null) return null;
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? n : null;
}

/** MySQL returns information_schema column names in the server's case (often
 *  UPPERCASE, e.g. ORDINAL_POSITION) while PG returns lowercase. Lowercase every
 *  key so the shared assembleSchema (which reads lowercase) works for both. */
function lowerKeys(rows: Record<string, unknown>[]): Record<string, unknown>[] {
  return rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k.toLowerCase(), v])));
}

/** pg SSL option: relaxed verification so managed-cloud cert chains connect. */
function pgSslOption(cfg: TcpConfig): false | { rejectUnauthorized: false } {
  return cfg.ssl === 'require' ? { rejectUnauthorized: false } : false;
}

/** mysql2 SSL option. */
function mySslOption(cfg: TcpConfig): undefined | { rejectUnauthorized: false } {
  return cfg.ssl === 'require' ? { rejectUnauthorized: false } : undefined;
}

export class TcpDriverProvider implements ConnectionProvider {
  readonly dialect: Dialect;
  private pgPool: PgPool | null = null;
  private myPool: mysql.Pool | null = null;

  constructor(private readonly config: TcpConfig) {
    this.dialect = config.dialect;
  }

  private pg(): PgPool {
    if (!this.pgPool) {
      this.pgPool = new PgPool({
        host: this.config.host,
        port: this.config.port,
        database: this.config.database,
        user: this.config.user,
        password: this.config.password,
        ssl: pgSslOption(this.config),
        max: 4,
      });
    }
    return this.pgPool;
  }

  /**
   * Acquire a PG client with read-only + timeout AWAITED before the caller runs
   * any query (RT-F2). The `pool.on('connect')` event does not await, so it could
   * leak a read-write connection on a freshly-spawned physical connection —
   * applying per-checkout here is the guaranteed path. Caller must release().
   */
  private async pgClient() {
    const client = await this.pg().connect();
    await client.query('SET default_transaction_read_only = on');
    await client.query(`SET statement_timeout = ${DEFAULT_TIMEOUT_MS}`);
    return client;
  }

  private my(): mysql.Pool {
    if (!this.myPool) {
      this.myPool = mysql.createPool({
        host: this.config.host,
        port: this.config.port,
        database: this.config.database,
        user: this.config.user,
        password: this.config.password,
        ssl: mySslOption(this.config),
        connectionLimit: 4,
        multipleStatements: false, // RT-F1: no stacked queries at the driver level
      });
    }
    return this.myPool;
  }

  /** Acquire a MySQL connection with read-only + timeout re-applied (RT-F2). */
  private async myConn(): Promise<mysql.PoolConnection> {
    const conn = await this.my().getConnection();
    await conn.query('SET SESSION TRANSACTION READ ONLY');
    await conn.query(`SET SESSION max_execution_time = ${DEFAULT_TIMEOUT_MS}`);
    return conn;
  }

  async testConnection(): Promise<void> {
    if (this.dialect === 'postgres') {
      const client = await this.pgClient();
      try {
        await client.query('SELECT 1');
      } finally {
        client.release();
      }
    } else {
      const conn = await this.myConn();
      try {
        await conn.query('SELECT 1');
      } finally {
        conn.release();
      }
    }
  }

  async probeWritePrivilege(): Promise<WritePrivilegeProbe> {
    // Probe the ACTUAL write grant by attempting a real CREATE TABLE inside a
    // transaction, then rolling back — nothing persists. TEMP tables are a bad
    // signal: any role can create them (they need only the database TEMP
    // privilege, granted to PUBLIC by default), so a SELECT-only user would look
    // writable. A permanent CREATE requires real DDL privilege.
    const NAME = '__mydbmate_probe__';
    if (this.dialect === 'postgres') {
      const probePool = new PgPool({
        host: this.config.host, port: this.config.port, database: this.config.database,
        user: this.config.user, password: this.config.password, ssl: pgSslOption(this.config), max: 1,
      });
      const client = await probePool.connect();
      try {
        await client.query('BEGIN');
        await client.query(`CREATE TABLE ${NAME} (x int)`);
        await client.query('ROLLBACK'); // never persists
        return { isReadOnly: false, detail: 'DB user can create tables — NOT SELECT-only. Use a SELECT-only role for production safety.' };
      } catch {
        await client.query('ROLLBACK').catch(() => {});
        return { isReadOnly: true, detail: 'DB user appears SELECT-only (write rejected).' };
      } finally {
        client.release();
        await probePool.end();
      }
    } else {
      // MySQL DDL is not transactional (CREATE TABLE auto-commits), so create then
      // drop. Use a FRESH connection (not the pool): pooled connections may carry a
      // lingering `SET SESSION TRANSACTION READ ONLY` from a prior read query, which
      // would make even a writable user's CREATE fail and mis-report read-only.
      const probeConn = await mysql.createConnection({
        host: this.config.host, port: this.config.port, database: this.config.database,
        user: this.config.user, password: this.config.password, ssl: mySslOption(this.config),
      });
      try {
        await probeConn.query(`CREATE TABLE \`${NAME}\` (x int)`);
        // DROP failure is non-fatal (the write already proved not-read-only), but warn
        // so a leaked probe table is observable — MySQL DDL is non-transactional.
        await probeConn.query(`DROP TABLE \`${NAME}\``).catch((e) => {
          console.warn(`[probe] failed to drop probe table ${NAME}; it may persist:`, e instanceof Error ? e.message : e);
        });
        return { isReadOnly: false, detail: 'DB user can create tables — NOT SELECT-only. Use a SELECT-only grant for production safety.' };
      } catch {
        return { isReadOnly: true, detail: 'DB user appears SELECT-only (write rejected).' };
      } finally {
        await probeConn.end();
      }
    }
  }

  async introspectSchema(): Promise<IntrospectedSchema> {
    return this.dialect === 'postgres' ? this.introspectPg() : this.introspectMy();
  }

  private async introspectPg(): Promise<IntrospectedSchema> {
    const pool = await this.pgClient();
    try {
    const cols = await pool.query(`
      SELECT c.table_schema, c.table_name, c.column_name, c.data_type,
             c.is_nullable, c.ordinal_position,
             CASE WHEN pk.column_name IS NOT NULL THEN true ELSE false END AS is_pk
      FROM information_schema.columns c
      LEFT JOIN (
        SELECT kcu.table_schema, kcu.table_name, kcu.column_name
        FROM information_schema.table_constraints tc
        JOIN information_schema.key_column_usage kcu
          ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
        WHERE tc.constraint_type = 'PRIMARY KEY'
      ) pk ON pk.table_schema = c.table_schema AND pk.table_name = c.table_name AND pk.column_name = c.column_name
      WHERE c.table_schema NOT IN ('pg_catalog','information_schema')
      ORDER BY c.table_schema, c.table_name, c.ordinal_position
    `);
    const fks = await pool.query(`
      SELECT kcu.table_name AS from_table, kcu.column_name AS from_column,
             ccu.table_name AS to_table, ccu.column_name AS to_column
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu ON tc.constraint_name = kcu.constraint_name
      JOIN information_schema.constraint_column_usage ccu ON ccu.constraint_name = tc.constraint_name
      WHERE tc.constraint_type = 'FOREIGN KEY'
    `);
    // Cheap row-count estimate from planner statistics (red-team C2). reltuples is
    // an estimate (-1 before first ANALYZE/VACUUM) — good enough for a big-table
    // heuristic, and never a full scan.
    const counts = await pool.query(`
      SELECT n.nspname AS table_schema, c.relname AS table_name,
             CASE WHEN c.reltuples < 0 THEN NULL ELSE c.reltuples::bigint END AS row_count
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relkind = 'r' AND n.nspname NOT IN ('pg_catalog','information_schema')
    `);
    const rowCounts = new Map<string, number | null>();
    for (const r of counts.rows) {
      rowCounts.set(`${String(r.table_schema)}.${String(r.table_name)}`, toRowCount(r.row_count));
    }
    return this.assembleSchema(cols.rows, fks.rows, true, rowCounts);
    } finally {
      pool.release();
    }
  }

  private async introspectMy(): Promise<IntrospectedSchema> {
    const conn = await this.myConn();
    try {
      const [cols] = await conn.query(
        `SELECT table_schema, table_name, column_name, data_type, is_nullable,
                ordinal_position, (column_key='PRI') AS is_pk
         FROM information_schema.columns
         WHERE table_schema = ?
         ORDER BY table_name, ordinal_position`,
        [this.config.database],
      );
      const [fks] = await conn.query(
        `SELECT table_name AS from_table, column_name AS from_column,
                referenced_table_name AS to_table, referenced_column_name AS to_column
         FROM information_schema.key_column_usage
         WHERE table_schema = ? AND referenced_table_name IS NOT NULL`,
        [this.config.database],
      );
      // Cheap row-count estimate (red-team C2). TABLE_ROWS is approximate for
      // InnoDB — fine for a big-table heuristic, and never a full scan.
      const [countRows] = await conn.query(
        `SELECT table_name, table_rows AS row_count
         FROM information_schema.tables
         WHERE table_schema = ? AND table_type = 'BASE TABLE'`,
        [this.config.database],
      );
      const rowCounts = new Map<string, number | null>();
      for (const r of lowerKeys(countRows as Record<string, unknown>[])) {
        rowCounts.set(`.${String(r.table_name)}`, toRowCount(r.row_count));
      }
      return this.assembleSchema(lowerKeys(cols as Record<string, unknown>[]), lowerKeys(fks as Record<string, unknown>[]), false, rowCounts);
    } finally {
      conn.release();
    }
  }

  private assembleSchema(
    colRows: Record<string, unknown>[],
    fkRows: Record<string, unknown>[],
    pg: boolean,
    rowCounts: Map<string, number | null>,
  ): IntrospectedSchema {
    const tableSet = new Map<string, { schemaName: string | null; tableName: string; rowCount: number | null }>();
    const columns: ColumnInfo[] = [];
    for (const r of colRows) {
      const tableName = String(r.table_name);
      const schemaName = pg ? String(r.table_schema) : null;
      const key = `${schemaName ?? ''}.${tableName}`;
      if (!tableSet.has(key)) {
        tableSet.set(key, { schemaName, tableName, rowCount: rowCounts.get(key) ?? null });
      }
      columns.push({
        tableName,
        schemaName,
        columnName: String(r.column_name),
        dataType: String(r.data_type),
        isNullable: String(r.is_nullable).toUpperCase() === 'YES',
        isPrimaryKey: r.is_pk === true || r.is_pk === 1 || String(r.is_pk) === '1',
        ordinalPosition: Number(r.ordinal_position),
      });
    }
    const foreignKeys: ForeignKeyInfo[] = fkRows.map((r) => ({
      fromTable: String(r.from_table),
      fromColumn: String(r.from_column),
      toTable: String(r.to_table),
      toColumn: String(r.to_column),
    }));
    return { tables: [...tableSet.values()], columns, foreignKeys };
  }

  async executeReadOnly(sql: string, opts?: { timeoutMs?: number }): Promise<QueryResult> {
    if (this.dialect === 'postgres') {
      // pgClient() has already awaited read-only + default timeout on this checkout.
      const client = await this.pgClient();
      try {
        if (opts?.timeoutMs) await client.query(`SET statement_timeout = ${opts.timeoutMs}`);
        const res = await client.query({ text: sql, rowMode: 'array' });
        const columns = res.fields.map((f) => f.name);
        return { columns, rows: res.rows as unknown[][], rowCount: res.rowCount ?? res.rows.length };
      } finally {
        client.release();
      }
    } else {
      const conn = await this.myConn();
      try {
        const [rows, fields] = await conn.query({ sql, rowsAsArray: true });
        const columns = Array.isArray(fields) ? fields.map((f) => (f as { name: string }).name) : [];
        const rowArr = rows as unknown[][];
        return { columns, rows: rowArr, rowCount: rowArr.length };
      } finally {
        conn.release();
      }
    }
  }

  async explainQuery(sql: string) {
    if (this.dialect === 'postgres') {
      const client = await this.pgClient();
      try {
        const res = await client.query(`EXPLAIN (FORMAT JSON) ${sql}`);
        const queryPlan = (res.rows[0] as { 'QUERY PLAN': { Plan: Record<string, unknown> }[] })['QUERY PLAN'];
        return this.parsePgPlan(queryPlan[0].Plan, JSON.stringify(queryPlan, null, 2));
      } finally {
        client.release();
      }
    } else {
      const conn = await this.myConn();
      try {
        const [rows] = await conn.query(`EXPLAIN FORMAT=JSON ${sql}`);
        // MySQL returns { EXPLAIN: "<json string>" }; MariaDB shape differs / lacks cost.
        const raw = (rows as { EXPLAIN?: string }[])[0]?.EXPLAIN;
        return this.parseMyPlan(raw);
      } finally {
        conn.release();
      }
    }
  }

  private parsePgPlan(plan: Record<string, unknown>, raw?: string) {
    let hasFullScan = false;
    let tableCount = 0;
    let estimatedRows = 0;
    const walk = (n: Record<string, unknown>) => {
      const nodeType = String(n['Node Type'] ?? '');
      if (nodeType === 'Seq Scan') hasFullScan = true;
      if (n['Relation Name']) tableCount++;
      estimatedRows = Math.max(estimatedRows, Number(n['Plan Rows'] ?? 0));
      for (const child of (n['Plans'] as Record<string, unknown>[] | undefined) ?? []) walk(child);
    };
    walk(plan);
    return { estimatedRows, estimatedCost: Number(plan['Total Cost'] ?? 0) || null, hasFullScan, tableCount, raw };
  }

  private parseMyPlan(raw: string | undefined) {
    // Score primarily on estimated rows (both MySQL and MariaDB expose it, though
    // under different JSON shapes). Missing cost → leave null (P3 escalates tier).
    if (!raw) return { estimatedRows: null, estimatedCost: null, hasFullScan: false, tableCount: 0 };
    let doc: unknown;
    try { doc = JSON.parse(raw); } catch { return { estimatedRows: null, estimatedCost: null, hasFullScan: false, tableCount: 0 }; }
    let estimatedRows = 0;
    let estimatedCost: number | null = null;
    let hasFullScan = false;
    let tableCount = 0;
    const walk = (o: unknown) => {
      if (!o || typeof o !== 'object') return;
      const rec = o as Record<string, unknown>;
      if (rec.table && typeof rec.table === 'object') {
        tableCount++;
        const t = rec.table as Record<string, unknown>;
        if (t.access_type === 'ALL') hasFullScan = true;
        const rows = Number(t.rows_examined_per_scan ?? t.rows ?? 0);
        estimatedRows = Math.max(estimatedRows, rows);
        const ci = t.cost_info as Record<string, unknown> | undefined;
        if (ci?.query_cost != null) estimatedCost = Number(ci.query_cost);
      }
      for (const v of Object.values(rec)) walk(v);
    };
    walk(doc);
    return { estimatedRows: estimatedRows || null, estimatedCost, hasFullScan, tableCount, raw };
  }

  async close(): Promise<void> {
    if (this.pgPool) {
      await this.pgPool.end();
      this.pgPool = null;
    }
    if (this.myPool) {
      await this.myPool.end();
      this.myPool = null;
    }
  }
}
