/**
 * Phase 4 — API keys (for MCP access) + scheduled queries. Multi-user RBAC is
 * out of scope for the single-user dogfood build; API keys are the auth surface
 * for the MCP server. Keys are stored hashed (never plaintext) and scoped to a
 * connection (RT-F4).
 */
import { pgTable, uuid, text, timestamp, jsonb, integer, boolean } from 'drizzle-orm/pg-core';
import { connections } from './schema';

/** An API key for the MCP server. `keyHash` = sha256 of the token; the raw token
 *  is shown once at creation and never stored. Scoped to one connection + a max
 *  risk tier the key may auto-run (RT-F4/F5). */
export const apiKeys = pgTable('api_keys', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  keyHash: text('key_hash').notNull().unique(),
  connectionId: uuid('connection_id').references(() => connections.id, { onDelete: 'cascade' }),
  maxTier: text('max_tier').notNull().default('low'), // low | medium — high never auto-runs
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
});

/** A recurring NL question or verified SQL run on a schedule, delivered to a webhook. */
export const scheduledQueries = pgTable('scheduled_queries', {
  id: uuid('id').primaryKey().defaultRandom(),
  connectionId: uuid('connection_id').notNull().references(() => connections.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  mode: text('mode').notNull().default('sql'), // 'sql' (deterministic) | 'question' (agentic)
  sql: text('sql'),
  question: text('question'),
  cron: text('cron').notNull(), // node-cron expression
  webhookUrl: text('webhook_url'),
  isEnabled: boolean('is_enabled').notNull().default(true),
  lastRunAt: timestamp('last_run_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/** History of scheduled runs, including skipped (overlap lock) and failed. */
export const scheduledRuns = pgTable('scheduled_runs', {
  id: uuid('id').primaryKey().defaultRandom(),
  scheduleId: uuid('schedule_id').notNull().references(() => scheduledQueries.id, { onDelete: 'cascade' }),
  status: text('status').notNull(), // ok | skipped | blocked | error | delivery_failed
  rowCount: integer('row_count'),
  detail: text('detail'),
  result: jsonb('result').$type<{ columns: string[]; rows: unknown[][] }>(),
  ranAt: timestamp('ran_at', { withTimezone: true }).notNull().defaultNow(),
});
