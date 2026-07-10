/**
 * SQL Server / Azure SQL provider (`mssql`/tedious).
 *
 * Read-only boundary (RT-F2): SQL Server has no per-session read-only transaction
 * like Postgres, so the real guarantee is a `db_datareader`-only login. We do NOT
 * write a probe table to the customer's production database — instead we read the
 * effective permissions via IS_MEMBER / HAS_PERMS_BY_NAME (metadata only).
 *
 * TLS mapping mirrors the other providers' semantics:
 *   'disable'     → encrypt off
 *   'require'     → encrypt on, trustServerCertificate true  (encrypt, don't verify)
 *   'verify-full' → encrypt on, trustServerCertificate false (+ CA when supplied)
 */
import mssql from 'mssql';
import type {
  ConnectionProvider,
  Dialect,
  IntrospectedSchema,
  QueryResult,
  WritePrivilegeProbe,
  ColumnInfo,
  ForeignKeyInfo,
  ExplainEstimate,
} from './provider-interface';

export interface MssqlConfig {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  ssl?: 'require' | 'disable' | 'verify-full';
  sslCa?: string;
}

const DEFAULT_TIMEOUT_MS = 30_000;

export class MssqlDriverProvider implements ConnectionProvider {
  readonly dialect: Dialect = 'mssql';
  private pool: mssql.ConnectionPool | null = null;

  constructor(private readonly config: MssqlConfig) {}

  private encryptOptions() {
    const ssl = this.config.ssl ?? 'disable';
    if (ssl === 'disable') return { encrypt: false, trustServerCertificate: true };
    if (ssl === 'verify-full') {
      return {
        encrypt: true,
        trustServerCertificate: false,
        ...(this.config.sslCa?.trim() ? { cryptoCredentialsDetails: { ca: this.config.sslCa } } : {}),
      };
    }
    // 'require' — encrypt without verifying the chain (matches PG/MySQL 'require').
    return { encrypt: true, trustServerCertificate: true };
  }

  private async getPool(): Promise<mssql.ConnectionPool> {
    if (!this.pool) {
      this.pool = await new mssql.ConnectionPool({
        server: this.config.host,
        port: this.config.port,
        database: this.config.database,
        user: this.config.user,
        password: this.config.password,
        pool: { max: 4, min: 0 },
        options: { ...this.encryptOptions(), enableArithAbort: true },
        connectionTimeout: 15_000,
        requestTimeout: DEFAULT_TIMEOUT_MS,
      }).connect();
    }
    return this.pool;
  }

  async testConnection(): Promise<void> {
    const pool = await this.getPool();
    await pool.request().query('SELECT 1 AS ok');
  }

  async probeWritePrivilege(): Promise<WritePrivilegeProbe> {
    // Metadata-only: never issues DDL against the target DB. A db_datareader-only
    // login has none of these grants; anything else is treated as writable.
    const pool = await this.getPool();
    // HAS_PERMS_BY_NAME must name the DATABASE securable — (NULL,NULL,...) is the
    // SERVER class and always returns NULL for CREATE TABLE / INSERT, which would
    // let a grant-based writer (not in a fixed role) read as read-only.
    const r = await pool.request().query(`
      SELECT
        IS_MEMBER('db_owner')       AS is_owner,
        IS_MEMBER('db_datawriter')  AS is_writer,
        IS_MEMBER('db_ddladmin')    AS is_ddladmin,
        HAS_PERMS_BY_NAME(DB_NAME(), 'DATABASE', 'CREATE TABLE') AS can_create,
        HAS_PERMS_BY_NAME(DB_NAME(), 'DATABASE', 'INSERT')       AS can_insert
    `);
    const row = r.recordset[0] as Record<string, number | null>;
    const writable = [row.is_owner, row.is_writer, row.is_ddladmin, row.can_create, row.can_insert]
      .some((v) => v === 1);
    return writable
      ? { isReadOnly: false, detail: 'DB user has write/DDL permissions — NOT SELECT-only. Use a db_datareader-only login for production safety.' }
      : { isReadOnly: true, detail: 'DB user appears read-only (no write/DDL permissions).' };
  }

  async introspectSchema(): Promise<IntrospectedSchema> {
    const pool = await this.getPool();

    const colsQ = await pool.request().query(`
      SELECT c.TABLE_SCHEMA AS table_schema, c.TABLE_NAME AS table_name, c.COLUMN_NAME AS column_name,
             c.DATA_TYPE AS data_type, c.IS_NULLABLE AS is_nullable, c.ORDINAL_POSITION AS ordinal_position,
             CASE WHEN pk.COLUMN_NAME IS NOT NULL THEN 1 ELSE 0 END AS is_pk
      FROM INFORMATION_SCHEMA.COLUMNS c
      JOIN INFORMATION_SCHEMA.TABLES t
        ON t.TABLE_SCHEMA = c.TABLE_SCHEMA AND t.TABLE_NAME = c.TABLE_NAME AND t.TABLE_TYPE = 'BASE TABLE'
      LEFT JOIN (
        SELECT ku.TABLE_SCHEMA, ku.TABLE_NAME, ku.COLUMN_NAME
        FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc
        JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE ku
          ON tc.CONSTRAINT_NAME = ku.CONSTRAINT_NAME AND tc.CONSTRAINT_SCHEMA = ku.CONSTRAINT_SCHEMA
        WHERE tc.CONSTRAINT_TYPE = 'PRIMARY KEY'
      ) pk ON pk.TABLE_SCHEMA = c.TABLE_SCHEMA AND pk.TABLE_NAME = c.TABLE_NAME AND pk.COLUMN_NAME = c.COLUMN_NAME
      ORDER BY c.TABLE_SCHEMA, c.TABLE_NAME, c.ORDINAL_POSITION
    `);

    const fksQ = await pool.request().query(`
      SELECT OBJECT_NAME(fkc.parent_object_id) AS from_table,
             pc.name AS from_column,
             OBJECT_NAME(fkc.referenced_object_id) AS to_table,
             rc.name AS to_column
      FROM sys.foreign_key_columns fkc
      JOIN sys.columns pc ON pc.object_id = fkc.parent_object_id AND pc.column_id = fkc.parent_column_id
      JOIN sys.columns rc ON rc.object_id = fkc.referenced_object_id AND rc.column_id = fkc.referenced_column_id
    `);

    // Approximate row counts from partition stats (cheap; avoids COUNT(*) scans).
    const rcQ = await pool.request().query(`
      SELECT s.name AS schema_name, t.name AS table_name, SUM(p.rows) AS row_count
      FROM sys.tables t
      JOIN sys.schemas s ON s.schema_id = t.schema_id
      JOIN sys.partitions p ON p.object_id = t.object_id AND p.index_id IN (0, 1)
      GROUP BY s.name, t.name
    `);
    const rowCounts = new Map<string, number | null>();
    for (const r of rcQ.recordset as Record<string, unknown>[]) {
      rowCounts.set(`${String(r.schema_name)}.${String(r.table_name)}`, Number(r.row_count) || null);
    }

    const tableSet = new Map<string, { schemaName: string | null; tableName: string; rowCount: number | null }>();
    const columns: ColumnInfo[] = [];
    for (const r of colsQ.recordset as Record<string, unknown>[]) {
      const tableName = String(r.table_name);
      const schemaName = String(r.table_schema);
      const key = `${schemaName}.${tableName}`;
      if (!tableSet.has(key)) {
        tableSet.set(key, { schemaName, tableName, rowCount: rowCounts.get(key) ?? null });
      }
      columns.push({
        tableName,
        schemaName,
        columnName: String(r.column_name),
        dataType: String(r.data_type),
        isNullable: String(r.is_nullable).toUpperCase() === 'YES',
        isPrimaryKey: r.is_pk === 1 || String(r.is_pk) === '1',
        ordinalPosition: Number(r.ordinal_position),
      });
    }
    const foreignKeys: ForeignKeyInfo[] = (fksQ.recordset as Record<string, unknown>[]).map((r) => ({
      fromTable: String(r.from_table),
      fromColumn: String(r.from_column),
      toTable: String(r.to_table),
      toColumn: String(r.to_column),
    }));
    return { tables: [...tableSet.values()], columns, foreignKeys };
  }

  async executeReadOnly(sql: string, _opts?: { timeoutMs?: number }): Promise<QueryResult> {
    // Statement timeout is enforced by the pool's requestTimeout (mssql has no
    // per-request override); the default matches the other providers' 30s.
    const pool = await this.getPool();
    const req = pool.request();
    req.arrayRowMode = true;
    const res = await req.query(sql);
    // With arrayRowMode the recordset is an array of arrays; column metadata is an
    // ARRAY of { index, name } (NOT an object keyed by name — Object.keys would
    // give "0","1",…). Order by index and take the real name.
    const meta = (res.recordset as unknown as { columns?: { index: number; name: string }[] })?.columns ?? [];
    const columns = [...meta].sort((a, b) => a.index - b.index).map((c, i) => c.name || String(i));
    const rows = (res.recordset as unknown as unknown[][]) ?? [];
    return { columns, rows, rowCount: rows.length };
  }

  async explainQuery(sql: string): Promise<ExplainEstimate> {
    // SHOWPLAN_XML returns the estimated plan WITHOUT executing the query. It is a
    // session-level SET, so it and the query must run on the SAME connection — a
    // pooled request may land on a different one. Use a dedicated connection and
    // run both in one batch; the query result is the plan XML, not table data.
    const conn = new mssql.ConnectionPool({
      server: this.config.host, port: this.config.port, database: this.config.database,
      user: this.config.user, password: this.config.password,
      pool: { max: 1, min: 0 },
      options: { ...this.encryptOptions(), enableArithAbort: true },
      connectionTimeout: 15_000, requestTimeout: DEFAULT_TIMEOUT_MS,
    });
    let raw = '';
    try {
      await conn.connect();
      // SET SHOWPLAN_XML ON must be the only statement in its batch; the plan is
      // returned by the NEXT batch on the same connection (which does not execute).
      await conn.request().batch('SET SHOWPLAN_XML ON');
      const res = await conn.request().batch(sql);
      const rec = res.recordset?.[0] as Record<string, unknown> | undefined;
      raw = rec ? String(Object.values(rec)[0] ?? '') : '';
    } finally {
      await conn.close().catch(() => {});
    }
    // Rough signals from the plan XML: a full-table scan and an estimated row count.
    const hasFullScan = /TableScan|Clustered Index Scan/i.test(raw);
    const rowMatch = raw.match(/EstimateRows="([\d.eE+]+)"/);
    const estimatedRows = rowMatch ? Math.round(Number(rowMatch[1])) : null;
    const tableCount = (raw.match(/<RelOp/g) ?? []).length;
    return { estimatedRows, estimatedCost: null, hasFullScan, tableCount, raw };
  }

  async close(): Promise<void> {
    if (this.pool) {
      await this.pool.close();
      this.pool = null;
    }
  }
}
