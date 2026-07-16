import { pgTable, uuid, text, timestamp, doublePrecision, jsonb } from 'drizzle-orm/pg-core';
import { connections } from './schema';
import { vector384 } from './vector-type';

/** A tracked metric: owner-defined SQL returning exactly (time_bucket, numeric value).
 *  Shape is validated by a trial run at create/update time; after that runMetric may
 *  skip the risk gate (the SQL is app-validated stored SQL, and connectionId is
 *  immutable so it can never be replayed against another database). */
export const metrics = pgTable('metrics', {
  id: uuid('id').primaryKey().defaultRandom(),
  connectionId: uuid('connection_id').notNull().references(() => connections.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  description: text('description'),
  sql: text('sql').notNull(),
  /** Bucket size of the time column — drives sparkline labels and digest wording. */
  timeGrain: text('time_grain').notNull().default('month'),
  /** Which direction is good news: colors the delta badge and digest tone. */
  direction: text('direction').notNull().default('up_good'),
  /** Goal value; on/off-track derived from direction. doublePrecision (not
   *  numeric) so drizzle returns a number, not a string. */
  target: doublePrecision('target'),
  /** ≤3 column names the digest slices by for top-driver breakdowns. */
  dimensions: jsonb('dimensions').$type<string[]>(),
  /** Embedding of name+description (384-dim, same model as glossary/verified-queries),
   *  so a chat question can retrieve this metric's governed definition for the
   *  text-to-SQL prompt. Nullable — existing rows null until re-saved/backfilled. */
  embedding: vector384('embedding'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
