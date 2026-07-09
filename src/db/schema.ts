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
  // Result of the write-privilege probe at test-connection time (RT-F2).
  isReadOnlyVerified: boolean('is_read_only_verified').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

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
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
