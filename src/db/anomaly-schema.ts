import { pgTable, uuid, text, timestamp, doublePrecision, index } from 'drizzle-orm/pg-core';
import { connections } from './schema';

/** Per-column distribution SUMMARY captured on each anomaly probe, so a later probe can
 *  detect DRIFT of the column's distribution over time (mean/nullRate trending) — distinct
 *  from the in-probe outlier check, which is recomputed live from a fresh sample. Only the
 *  summary is stored (not raw rows). Pruned by age (see anomaly-service RETENTION_DAYS). */
export const anomalyBaselines = pgTable(
  'anomaly_baselines',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    connectionId: uuid('connection_id').notNull().references(() => connections.id, { onDelete: 'cascade' }),
    tableName: text('table_name').notNull(),
    columnName: text('column_name').notNull(),
    /** Distribution summary at capture time. avg/stddev null for non-numeric columns. */
    avg: doublePrecision('avg'),
    stddev: doublePrecision('stddev'),
    nullRate: doublePrecision('null_rate').notNull(),
    capturedAt: timestamp('captured_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('anomaly_baselines_conn_table_col').on(t.connectionId, t.tableName, t.columnName)],
);
