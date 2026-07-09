/**
 * Phase 2 — Context Studio schema (the product's moat). Schema annotations,
 * business glossary, manual relationships, verified queries (few-shot source),
 * knowledge suggestions (mining inbox), and revision history. pgvector columns
 * back semantic retrieval; the extension is already enabled by the P1 migration.
 */
import { pgTable, uuid, text, boolean, timestamp, jsonb, doublePrecision } from 'drizzle-orm/pg-core';
import { connections, chatSessions } from './schema';
import { vector384 } from './vector-type';

/** Human/AI annotation on a table: description + business alias + deprecated flag. */
export const tableAnnotations = pgTable('table_annotations', {
  id: uuid('id').primaryKey().defaultRandom(),
  connectionId: uuid('connection_id').notNull().references(() => connections.id, { onDelete: 'cascade' }),
  tableName: text('table_name').notNull(),
  description: text('description'),
  businessAlias: text('business_alias'),
  isDeprecated: boolean('is_deprecated').notNull().default(false),
  // Where this came from (manual|auto|mined|document) + a 0..1 confidence used to
  // weight/gate retrieval (red-team H2: confidence must actually affect the prompt).
  provenance: text('provenance').notNull().default('manual'),
  confidence: doublePrecision('confidence').notNull().default(1),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/** Annotation on a column, incl. a `sensitive` flag used by P3 risk scoring. */
export const columnAnnotations = pgTable('column_annotations', {
  id: uuid('id').primaryKey().defaultRandom(),
  connectionId: uuid('connection_id').notNull().references(() => connections.id, { onDelete: 'cascade' }),
  tableName: text('table_name').notNull(),
  columnName: text('column_name').notNull(),
  description: text('description'),
  businessAlias: text('business_alias'),
  isSensitive: boolean('is_sensitive').notNull().default(false),
  provenance: text('provenance').notNull().default('manual'),
  confidence: doublePrecision('confidence').notNull().default(1),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/** Business glossary: term → definition → SQL mapping, embedded for retrieval. */
export const glossaryTerms = pgTable('glossary_terms', {
  id: uuid('id').primaryKey().defaultRandom(),
  connectionId: uuid('connection_id').notNull().references(() => connections.id, { onDelete: 'cascade' }),
  term: text('term').notNull(),
  definition: text('definition').notNull(),
  sqlMapping: text('sql_mapping'),
  synonyms: jsonb('synonyms').$type<string[]>(),
  embedding: vector384('embedding'),
  provenance: text('provenance').notNull().default('manual'),
  confidence: doublePrecision('confidence').notNull().default(1),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/** Manual relationships — production DBs often lack declared FK constraints. */
export const manualRelationships = pgTable('manual_relationships', {
  id: uuid('id').primaryKey().defaultRandom(),
  connectionId: uuid('connection_id').notNull().references(() => connections.id, { onDelete: 'cascade' }),
  fromTable: text('from_table').notNull(),
  fromColumn: text('from_column').notNull(),
  toTable: text('to_table').notNull(),
  toColumn: text('to_column').notNull(),
  note: text('note'),
});

/** Verified NL→SQL pairs — the few-shot source injected into the agent prompt. */
export const verifiedQueries = pgTable('verified_queries', {
  id: uuid('id').primaryKey().defaultRandom(),
  connectionId: uuid('connection_id').notNull().references(() => connections.id, { onDelete: 'cascade' }),
  question: text('question').notNull(),
  sql: text('sql').notNull(),
  tablesUsed: jsonb('tables_used').$type<string[]>(),
  embedding: vector384('embedding'),
  isDisabled: boolean('is_disabled').notNull().default(false), // demote/report bad pair
  /** Personal 1-click bookmark (P9-A4). A bookmark is a saved query for quick
   *  re-run; it does not change few-shot retrieval (which reads the same rows as
   *  before). Kept here instead of a near-duplicate saved_queries table. */
  isBookmark: boolean('is_bookmark').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/** Mined suggestions awaiting human approval in the Knowledge Inbox. */
export const knowledgeSuggestions = pgTable('knowledge_suggestions', {
  id: uuid('id').primaryKey().defaultRandom(),
  connectionId: uuid('connection_id').notNull().references(() => connections.id, { onDelete: 'cascade' }),
  kind: text('kind').notNull(), // 'glossary' | 'table_annotation' | 'column_annotation' | 'verified_query'
  payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
  reason: text('reason'),
  sourceSessionId: uuid('source_session_id').references(() => chatSessions.id, { onDelete: 'set null' }),
  status: text('status').notNull().default('pending'), // pending | accepted | rejected
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
