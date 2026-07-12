/**
 * Dashboard schema (P2). Pin a chat result → widget; group widgets on a dashboard;
 * share a dashboard read-only via a signed slug.
 *
 * Red-team-driven shape:
 * - Share shows OWNER-refreshed cached results (`lastResult`), never a live query
 *   from an anonymous viewer (H1/C3/C4) — so widgets carry their last result.
 * - `riskTier` is captured at pin time so the owner-refresh path can honor it (H2).
 * - FK onDelete is explicit (H5): both FKs cascade, matching the app convention.
 */
import { pgTable, uuid, text, timestamp, jsonb, integer } from 'drizzle-orm/pg-core';
import { connections } from './schema';

export const dashboards = pgTable('dashboards', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  /** Read-only share slug (128-bit CSPRNG hex). null = not shared. Regenerate = revoke. */
  shareSlug: text('share_slug').unique(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const dashboardWidgets = pgTable('dashboard_widgets', {
  id: uuid('id').primaryKey().defaultRandom(),
  dashboardId: uuid('dashboard_id')
    .notNull()
    .references(() => dashboards.id, { onDelete: 'cascade' }),
  connectionId: uuid('connection_id')
    .notNull()
    .references(() => connections.id, { onDelete: 'cascade' }),
  title: text('title').notNull(),
  /** The validated SELECT this widget runs. Never sent to the share view. */
  sql: text('sql').notNull(),
  /** Chart spec captured at pin time (null → table view). Re-validated on render. */
  chartSpec: jsonb('chart_spec'),
  /** Risk tier assessed at pin time (low|medium|high), for display/sorting. The
   *  owner-refresh path re-assesses risk LIVE through the query-executor (tier can
   *  drift as data grows), so this is an at-pin snapshot, not the enforced gate. */
  riskTier: text('risk_tier'),
  /** Owner-refreshed result the share view renders (no live execution for viewers). */
  lastResult: jsonb('last_result'),
  lastRefreshedAt: timestamp('last_refreshed_at', { withTimezone: true }),
  position: integer('position').notNull().default(0),
  /** Layout width: s = 1/3, m = 1/2, l = full row. */
  size: text('size').notNull().default('m'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
