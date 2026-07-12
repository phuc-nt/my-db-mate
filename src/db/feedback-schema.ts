import { pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { connections } from './schema';

/** Thumbs-down teach-flow log: what was asked, which SQL was wrong and why.
 *  Write-mostly — the actionable artifact is the corrected verified query
 *  (fixedVerifiedQueryId when the user saved one); this table keeps the trail
 *  for later analysis/eval. */
export const queryFeedback = pgTable('query_feedback', {
  id: uuid('id').primaryKey().defaultRandom(),
  connectionId: uuid('connection_id').notNull().references(() => connections.id, { onDelete: 'cascade' }),
  question: text('question').notNull(),
  sqlWrong: text('sql_wrong').notNull(),
  reason: text('reason').notNull(), // wrong-data | missing-context | misunderstood | other
  note: text('note'),
  sessionId: uuid('session_id'),
  fixedVerifiedQueryId: uuid('fixed_verified_query_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
