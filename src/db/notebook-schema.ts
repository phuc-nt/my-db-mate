/**
 * Notebook schema (P10-B3). "Save as notebook" collapses a chat session into a
 * read-only, shareable analysis (turn-by-turn: question → SQL → result → narrative).
 * Unlike a report (LLM-composed from pins), a notebook is the raw session captured
 * as a point-in-time snapshot. Sensitive-column results are omitted (red-team H3).
 */
import { pgTable, uuid, text, timestamp, jsonb } from 'drizzle-orm/pg-core';
import { connections } from './schema';

export const notebooks = pgTable('notebooks', {
  id: uuid('id').primaryKey().defaultRandom(),
  connectionId: uuid('connection_id')
    .notNull()
    .references(() => connections.id, { onDelete: 'cascade' }),
  title: text('title').notNull(),
  sessionId: uuid('session_id'),
  /** Rendered notebook markdown (turns as text; tables render from snapshot). */
  markdown: text('markdown').notNull(),
  /** { [turnId]: { columns, rows } } captured at save time — byte-capped. */
  dataSnapshot: jsonb('data_snapshot').notNull(),
  shareSlug: text('share_slug').unique(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
