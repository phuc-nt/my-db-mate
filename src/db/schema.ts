/**
 * My DB Mate app-DB schema (Postgres + pgvector).
 * Stores connections, synced target-DB schema snapshots, chat sessions, and an
 * audit log of every query run. Vector columns for context retrieval are added
 * in Phase 2 (the pgvector extension is enabled in the first migration so P2 is
 * purely additive).
 */
import {
  pgTable,
  uuid,
  text,
  integer,
  boolean,
  timestamp,
  jsonb,
  bigint,
  unique,
} from 'drizzle-orm/pg-core';

/** A registered target database. `kind` selects the ConnectionProvider; `config`
 *  holds kind-specific settings (host/port/db for tcp-driver, path for sqlite-file,
 *  url/token for remote-http). Secrets inside `config` are stored encrypted. */
export const connections = pgTable('connections', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  kind: text('kind').notNull(), // 'tcp-driver' | 'sqlite-file' | 'remote-http'
  dialect: text('dialect').notNull(), // 'postgres' | 'mysql' | 'sqlite'
  // Non-secret config (host, port, database, sqlite path...) as plain JSON.
  config: jsonb('config').notNull().$type<Record<string, unknown>>(),
  // Encrypted secret blob (password / token). AES-256-GCM, base64. Null for sqlite-file.
  secretEncrypted: text('secret_encrypted'),
  // Encrypted SSH private key / password when connecting via a bastion tunnel.
  // Separate column (not in `config`) so key material is never stored in plaintext.
  sshSecretEncrypted: text('ssh_secret_encrypted'),
  // Result of the write-privilege probe at test-connection time (RT-F2).
  isReadOnlyVerified: boolean('is_read_only_verified').notNull().default(false),
  // DuckDB accelerator opt-in (per-connection): route heavy queries through a
  // cached Parquet snapshot instead of the live driver. Off by default — this
  // must not change behavior on connections that haven't opted in.
  accelerateEnabled: boolean('accelerate_enabled').notNull().default(false),
  // Snapshot cache TTL in ms for this connection's accelerator. Nullable —
  // falls back to a app-wide default when unset.
  accelerateTtlMs: integer('accelerate_ttl_ms'),
  // BigQuery service-account JSON key, encrypted (AES-256-GCM, same mechanism as
  // secretEncrypted). Null for non-BigQuery connections.
  bigqueryServiceAccountJsonEncrypted: text('bigquery_service_account_json_encrypted'),
  // Hard cap passed as BigQuery's `maximumBytesBilled` job config — BigQuery itself
  // rejects the job (zero charge) if the query would bill more than this. bigint
  // (not integer): Postgres int4 caps at 2,147,483,647 and the 1 GiB default
  // (1,073,741,824) already sits at 50% of that ceiling. notNull with a default so
  // "missing cap" is a schema-level impossibility, never something executeReadOnly()
  // must defensively handle.
  bigqueryMaxBytesPerQuery: bigint('bigquery_max_bytes_per_query', { mode: 'number' }).notNull().default(1_073_741_824),
  // Per-connection DAILY byte budget for BigQuery background analytics (dashboards/
  // metrics/reports refreshing unattended). An additional cost layer ON TOP of the
  // per-query maximumBytesBilled cap — a background run is admitted only if the day's
  // committed + reserved bytes + this query's estimate stay under this budget.
  // notNull with a default (10× the per-query cap ≈ 10 GiB/day ≈ $0.06/day) so
  // "missing budget" is a schema-level impossibility → fail-closed by construction.
  bigqueryDailyBytesBudget: bigint('bigquery_daily_bytes_budget', { mode: 'number' }).notNull().default(10_737_418_240),
  // BigQuery offline mode (Mode 2): when on, background analytics (dashboards/metrics/
  // reports) for this connection serve from a DuckDB-over-BigQuery snapshot (one bounded
  // budgeted extract, then $0 reads until TTL) instead of querying BigQuery live each
  // refresh. Explicit opt-in — off by default; data is cached (staleness surfaced).
  bigqueryOfflineMode: boolean('bigquery_offline_mode').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/** Per-table incremental-refresh watermark config for the accelerator (opt-in,
 *  requires explicit user confirmation in the UI — never auto-enabled). When a
 *  row exists for a (connectionId, tableName) pair, `tryAccelerate` extracts
 *  only rows newer than `lastWatermark` instead of a full re-extract. */
export const accelerateWatermarkConfigs = pgTable('accelerate_watermark_configs', {
  id: uuid('id').primaryKey().defaultRandom(),
  connectionId: uuid('connection_id')
    .notNull()
    .references(() => connections.id, { onDelete: 'cascade' }),
  tableName: text('table_name').notNull(),
  watermarkCol: text('watermark_col').notNull(),
  // Last-seen watermark value as text (column may be TIMESTAMP or numeric in
  // the source DB) — compared/formatted back into the delta SQL by the caller.
  lastWatermark: text('last_watermark'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  uniqueTable: unique('accelerate_watermark_configs_connection_table_unique').on(t.connectionId, t.tableName),
}));

/** Queryable index of accelerator snapshot status, keyed by the same
 *  `(connectionId, cacheKey)` the filesystem cache uses (see
 *  `snapshot-cache-service.ts`'s `cacheKeyFor`). The `.meta.json` + Parquet
 *  file on disk remain the source of truth DuckDB reads from — this table is
 *  UI-facing only, upserted in place (no history) alongside every write to
 *  that filesystem cache, including failures. */
export const accelerateSnapshots = pgTable('accelerate_snapshots', {
  id: uuid('id').primaryKey().defaultRandom(),
  connectionId: uuid('connection_id')
    .notNull()
    .references(() => connections.id, { onDelete: 'cascade' }),
  cacheKey: text('cache_key').notNull(),
  sql: text('sql').notNull(),
  asOf: timestamp('as_of', { withTimezone: true }),
  sizeBytes: bigint('size_bytes', { mode: 'number' }),
  status: text('status').notNull(), // 'ready' | 'extracting' | 'failed'
  lastError: text('last_error'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  uniqueKey: unique('accelerate_snapshots_connection_cachekey_unique').on(t.connectionId, t.cacheKey),
}));

/** One row per table in a synced target schema. */
export const schemaTables = pgTable('schema_tables', {
  id: uuid('id').primaryKey().defaultRandom(),
  connectionId: uuid('connection_id')
    .notNull()
    .references(() => connections.id, { onDelete: 'cascade' }),
  schemaName: text('schema_name'),
  tableName: text('table_name').notNull(),
  /** Estimated row count captured at sync time — big-table guard source (C2). */
  rowCount: integer('row_count'),
  syncedAt: timestamp('synced_at', { withTimezone: true }).notNull().defaultNow(),
});

/** One row per column. */
export const schemaColumns = pgTable('schema_columns', {
  id: uuid('id').primaryKey().defaultRandom(),
  tableId: uuid('table_id')
    .notNull()
    .references(() => schemaTables.id, { onDelete: 'cascade' }),
  columnName: text('column_name').notNull(),
  dataType: text('data_type').notNull(),
  isNullable: boolean('is_nullable').notNull().default(true),
  isPrimaryKey: boolean('is_primary_key').notNull().default(false),
  ordinalPosition: integer('ordinal_position').notNull().default(0),
});

/** Foreign-key edges (from introspection where available). */
export const schemaForeignKeys = pgTable('schema_foreign_keys', {
  id: uuid('id').primaryKey().defaultRandom(),
  connectionId: uuid('connection_id')
    .notNull()
    .references(() => connections.id, { onDelete: 'cascade' }),
  fromTable: text('from_table').notNull(),
  fromColumn: text('from_column').notNull(),
  toTable: text('to_table').notNull(),
  toColumn: text('to_column').notNull(),
});

/** A chat session against one connection. */
export const chatSessions = pgTable('chat_sessions', {
  id: uuid('id').primaryKey().defaultRandom(),
  connectionId: uuid('connection_id')
    .notNull()
    .references(() => connections.id, { onDelete: 'cascade' }),
  title: text('title'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/** A message within a session. `parts` holds the AI SDK message parts (text, tool calls). */
export const chatMessages = pgTable('chat_messages', {
  id: uuid('id').primaryKey().defaultRandom(),
  sessionId: uuid('session_id')
    .notNull()
    .references(() => chatSessions.id, { onDelete: 'cascade' }),
  role: text('role').notNull(), // 'user' | 'assistant'
  content: text('content').notNull(),
  parts: jsonb('parts').$type<unknown[]>(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/** Audit log: every SQL execution attempt against a target DB (RT — audit is mandatory). */
export const queryRuns = pgTable('query_runs', {
  id: uuid('id').primaryKey().defaultRandom(),
  connectionId: uuid('connection_id')
    .notNull()
    .references(() => connections.id, { onDelete: 'cascade' }),
  sessionId: uuid('session_id').references(() => chatSessions.id, {
    onDelete: 'set null',
  }),
  actor: text('actor').notNull().default('owner'), // identity propagation seam (P4 fills real users)
  sql: text('sql').notNull(),
  status: text('status').notNull(), // 'ok' | 'blocked' | 'error'
  blockedReason: text('blocked_reason'),
  rowCount: integer('row_count'),
  durationMs: bigint('duration_ms', { mode: 'number' }),
  // BigQuery-only: real bytes billed by this run, accumulated into the per-connection
  // daily budget tally. Nullable — non-BigQuery runs (and blocked/errored runs) have no
  // billed figure. For a SUCCESSFUL BigQuery run whose billed figure can't be read from
  // job metadata, this holds the per-query cap sentinel (pessimistic over-count), never
  // null/0, so the daily tally can never silently undercount and bypass the budget.
  bytesBilled: bigint('bytes_billed', { mode: 'number' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/** Per-connection, per-UTC-day BigQuery byte-budget ledger (reserve-then-reconcile).
 *  `reserved` = in-flight estimates for admitted-but-not-yet-settled background runs;
 *  `committed` = settled real billed bytes for the day. Admission is an atomic
 *  conditional UPDATE (`reserved + committed + estimate <= budget`), so concurrent
 *  background refreshes cannot collectively overspend WITHOUT holding a DB lock across
 *  the multi-second BigQuery job (Red Team #2). One row per (connectionId, utcDay). */
export const bqBudgetLedger = pgTable(
  'bq_budget_ledger',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    connectionId: uuid('connection_id')
      .notNull()
      .references(() => connections.id, { onDelete: 'cascade' }),
    utcDay: text('utc_day').notNull(), // 'YYYY-MM-DD' (UTC), matches defaultDateRange's convention
    reservedBytes: bigint('reserved_bytes', { mode: 'number' }).notNull().default(0),
    committedBytes: bigint('committed_bytes', { mode: 'number' }).notNull().default(0),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique('bq_budget_ledger_conn_day').on(t.connectionId, t.utcDay)],
);
