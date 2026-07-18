import { pgTable, uuid, text, timestamp, jsonb, integer, boolean } from 'drizzle-orm/pg-core';
import { connections } from './schema';

/** Condition a finding must match for a trigger to fire. Deterministic enum +
 *  threshold only — deliberately NOT a user-supplied expression language. */
export interface TriggerCondition {
  /** Which pipeline emits the findings this trigger watches. */
  surface: 'monitor' | 'digest';
  /** Optional exact table (monitor) / metric name (digest) filter. */
  tableOrMetric?: string;
  kind: 'any' | 'name-match' | 'delta-threshold';
  /** |deltaPct| >= threshold, for kind 'delta-threshold'. */
  threshold?: number;
}

/** An action trigger: "when a finding matches CONDITION, POST TEMPLATE to URL".
 *  Webhook-out ONLY — nothing here can write to a source database (the module
 *  never imports a connection provider or any execution API). */
export const actionTriggers = pgTable('action_triggers', {
  id: uuid('id').primaryKey().defaultRandom(),
  connectionId: uuid('connection_id').notNull().references(() => connections.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  isEnabled: boolean('is_enabled').notNull().default(true),
  condition: jsonb('condition').notNull().$type<TriggerCondition>(),
  webhookUrl: text('webhook_url').notNull(),
  /** JSON body template with fixed {{placeholders}} — validated at save AND at
   *  fire time (an invalid render is recorded, never sent). */
  payloadTemplate: text('payload_template').notNull(),
  /** Sliding-window fires/hour cap; beyond it fires are recorded as suppressed. */
  rateLimitPerHour: integer('rate_limit_per_hour').notNull().default(10),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/** Append-only audit of every fire attempt (delivered, failed, suppressed,
 *  blocked, template_error, test). Also the data the rate limiter counts. */
export const actionTriggerFires = pgTable('action_trigger_fires', {
  id: uuid('id').primaryKey().defaultRandom(),
  triggerId: uuid('trigger_id').notNull().references(() => actionTriggers.id, { onDelete: 'cascade' }),
  status: text('status').notNull(),
  httpStatus: integer('http_status'),
  error: text('error'),
  /** The finding that matched, as fired — so history stays meaningful after the
   *  source run is pruned. */
  findingSnapshot: jsonb('finding_snapshot').$type<Record<string, unknown>>(),
  firedAt: timestamp('fired_at', { withTimezone: true }).notNull().defaultNow(),
});
