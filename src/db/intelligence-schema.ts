/**
 * Phase 3 — eval sets + column profiles. Eval runs against a stable fixture DB
 * (NOT live production) so gold hashes are reproducible (RT-F12). Column profiles
 * enrich the agent's understanding of real values (enum codes, null rates).
 */
import { pgTable, uuid, text, integer, boolean, timestamp, jsonb, doublePrecision, bigint } from 'drizzle-orm/pg-core';
import { connections } from './schema';

/** A gold NL→SQL pair for regression eval. */
export const evalQueries = pgTable('eval_queries', {
  id: uuid('id').primaryKey().defaultRandom(),
  connectionId: uuid('connection_id').notNull().references(() => connections.id, { onDelete: 'cascade' }),
  question: text('question').notNull(),
  goldSql: text('gold_sql').notNull(),
  complexity: text('complexity').notNull().default('medium'), // simple | medium | hard
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/** One eval run (all gold queries executed against generated SQL). */
export const evalRuns = pgTable('eval_runs', {
  id: uuid('id').primaryKey().defaultRandom(),
  connectionId: uuid('connection_id').notNull().references(() => connections.id, { onDelete: 'cascade' }),
  total: integer('total').notNull(),
  executionMatch: integer('execution_match').notNull(),
  structuralMatch: integer('structural_match').notNull(),
  model: text('model'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/** Per-query result within a run. */
export const evalResults = pgTable('eval_results', {
  id: uuid('id').primaryKey().defaultRandom(),
  runId: uuid('run_id').notNull().references(() => evalRuns.id, { onDelete: 'cascade' }),
  evalQueryId: uuid('eval_query_id').notNull().references(() => evalQueries.id, { onDelete: 'cascade' }),
  generatedSql: text('generated_sql'),
  executionMatch: boolean('execution_match').notNull(),
  structuralMatch: boolean('structural_match').notNull(),
  note: text('note'),
});

/** Profile of a column's real values (distinct values, null rate, min/max). */
export const columnProfiles = pgTable('column_profiles', {
  id: uuid('id').primaryKey().defaultRandom(),
  connectionId: uuid('connection_id').notNull().references(() => connections.id, { onDelete: 'cascade' }),
  tableName: text('table_name').notNull(),
  columnName: text('column_name').notNull(),
  distinctValues: jsonb('distinct_values').$type<unknown[]>(), // populated when cardinality is small
  nullRate: doublePrecision('null_rate'),
  minValue: text('min_value'),
  maxValue: text('max_value'),
  sampleValues: jsonb('sample_values').$type<unknown[]>(),
  totalRows: bigint('total_rows', { mode: 'number' }),
  profiledAt: timestamp('profiled_at', { withTimezone: true }).notNull().defaultNow(),
});
