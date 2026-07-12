import { pgTable, uuid, text, timestamp, jsonb } from 'drizzle-orm/pg-core';
import { connections } from './schema';

/** Point-in-time table metrics captured by a monitor schedule. Diffed against the
 *  previous capture to detect data drift (row-count collapse, null spikes, avg
 *  shifts). Pruned to the most recent 30 per (schedule, table). */
export const monitorSnapshots = pgTable('monitor_snapshots', {
  id: uuid('id').primaryKey().defaultRandom(),
  scheduleId: uuid('schedule_id').notNull(),
  connectionId: uuid('connection_id').notNull().references(() => connections.id, { onDelete: 'cascade' }),
  tableName: text('table_name').notNull(),
  /** { rowCount: number, columns: { [col]: { nullRate: number, avg: number|null } } } */
  metrics: jsonb('metrics').notNull().$type<{ rowCount: number; columns: Record<string, { nullRate: number; avg: number | null }> }>(),
  capturedAt: timestamp('captured_at', { withTimezone: true }).notNull().defaultNow(),
});
