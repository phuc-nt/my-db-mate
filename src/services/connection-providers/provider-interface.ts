/**
 * ConnectionProvider abstraction (RT — connection is not a hardcoded {host,port}).
 * Three kinds: tcp-driver (PG/MySQL), sqlite-file (better-sqlite3), remote-http
 * (D1/Supabase — P4). Each provider owns its dialect, read-only enforcement,
 * schema introspection, and query execution so the rest of the app is dialect-agnostic.
 */

export type Dialect = 'postgres' | 'mysql' | 'sqlite' | 'mssql';

export interface ColumnInfo {
  tableName: string;
  schemaName: string | null;
  columnName: string;
  dataType: string;
  isNullable: boolean;
  isPrimaryKey: boolean;
  ordinalPosition: number;
}

export interface ForeignKeyInfo {
  fromTable: string;
  fromColumn: string;
  toTable: string;
  toColumn: string;
}

export interface IntrospectedSchema {
  /** rowCount = estimated row count captured at sync time (red-team C2 big-table
   *  guard data source). null when the dialect can't estimate cheaply. */
  tables: { schemaName: string | null; tableName: string; rowCount: number | null }[];
  columns: ColumnInfo[];
  foreignKeys: ForeignKeyInfo[];
}

export interface QueryResult {
  columns: string[];
  rows: unknown[][];
  rowCount: number;
  /** Present when this result was served from the DuckDB accelerator's Parquet
   *  snapshot cache instead of the live driver — `asOf` is the snapshot's
   *  extraction time (ISO), so the UI can show staleness (Phase 3 badge).
   *  `skewWarning` is present for a multi-table JOIN whose per-table snapshots
   *  were extracted more than half the TTL apart — surfaces that the tables
   *  weren't all snapshotted at (approximately) the same moment. */
  accelerated?: { asOf: string; skewWarning?: { spreadMs: number } };
}

/** Result of probing whether the connection can write (RT-F2). */
export interface WritePrivilegeProbe {
  /** true = connection is genuinely read-only (safe); false = can write (warn). */
  isReadOnly: boolean;
  detail: string;
}

export interface ConnectionProvider {
  readonly dialect: Dialect;

  /** Verify the connection works. Throws on failure. */
  testConnection(): Promise<void>;

  /**
   * Probe write privilege — the real safety boundary is a SELECT-only grant / a
   * physically read-only handle, not a session flag (RT-F2). Returns whether the
   * connection is actually read-only so the UI can warn.
   */
  probeWritePrivilege(): Promise<WritePrivilegeProbe>;

  /** Introspect tables/columns/foreign keys. */
  introspectSchema(): Promise<IntrospectedSchema>;

  /**
   * Execute a validated read-only SQL statement. Providers enforce read-only at
   * the physical layer (readonly handle / read-only transaction re-applied per
   * acquire). The SQL must already have passed safety-service validation.
   */
  executeReadOnly(sql: string, opts?: { timeoutMs?: number }): Promise<QueryResult>;

  /**
   * Estimate a query's blast radius via EXPLAIN (plan-only, never ANALYZE).
   * Returns estimated rows examined + whether a full scan is planned. Used by P3
   * risk scoring — a performance/blast-radius guard, NOT a security control.
   * Runs read-only; bypasses the SELECT-only AST gate because EXPLAIN itself is
   * not a SELECT statement.
   */
  explainQuery(sql: string): Promise<ExplainEstimate>;

  /** Release pooled resources. */
  close(): Promise<void>;
}

export interface ExplainEstimate {
  /** Estimated rows examined/returned (both PG and MySQL/MariaDB expose this). */
  estimatedRows: number | null;
  /** Optional planner cost — MySQL only; MariaDB/SQLite omit it. */
  estimatedCost: number | null;
  /** True if the plan includes a full table scan (SQLite: SCAN; others: seq scan). */
  hasFullScan: boolean;
  /** Number of tables/joins referenced (crude complexity signal). */
  tableCount: number;
  /** Raw plan text/JSON as returned by the DB, for the Execution-Plan viewer
   *  (P9-A3). OPTIONAL — required would break every implementer + the risk-scoring
   *  inline fallback. Untrusted for remote (D1) → render escaped, text-only. */
  raw?: string;
}
