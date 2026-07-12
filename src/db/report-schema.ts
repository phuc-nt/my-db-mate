/**
 * Report schema (P3). A report gathers dashboard widgets / verified queries as
 * sources, runs them, and has an LLM compose a structured markdown narrative.
 * Reports are point-in-time snapshots (unlike dashboards, which are live-cached).
 *
 * Red-team-driven shape:
 * - Sources are keyed by their own `id` (= sourceId, M7) so the snapshot and the
 *   server-appended charts line up deterministically — the LLM only writes prose.
 * - report_versions has UNIQUE(reportId, version) so a concurrent regenerate can't
 *   create two rows at the same version (H6); the version is assigned in a txn.
 * - FK onDelete is explicit (H5): version/source cascade with the report; a source's
 *   widget/verified-query set null so deleting a widget doesn't break the report.
 */
import { pgTable, uuid, text, timestamp, jsonb, integer, unique } from 'drizzle-orm/pg-core';
import { dashboardWidgets } from './dashboard-schema';
import { verifiedQueries } from './context-schema';

export const reports = pgTable('reports', {
  id: uuid('id').primaryKey().defaultRandom(),
  title: text('title').notNull(),
  instruction: text('instruction'),
  shareSlug: text('share_slug').unique(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const reportSources = pgTable('report_sources', {
  id: uuid('id').primaryKey().defaultRandom(), // = sourceId, the key for snapshot + charts (M7)
  reportId: uuid('report_id')
    .notNull()
    .references(() => reports.id, { onDelete: 'cascade' }),
  widgetId: uuid('widget_id').references(() => dashboardWidgets.id, { onDelete: 'set null' }),
  verifiedQueryId: uuid('verified_query_id').references(() => verifiedQueries.id, { onDelete: 'set null' }),
  /** Notebook as a report source — prose+numbers from a saved analysis. */
  notebookId: uuid('notebook_id'),
  position: integer('position').notNull().default(0),
});

export const reportVersions = pgTable('report_versions', {
  id: uuid('id').primaryKey().defaultRandom(),
  reportId: uuid('report_id')
    .notNull()
    .references(() => reports.id, { onDelete: 'cascade' }),
  version: integer('version').notNull(),
  markdown: text('markdown').notNull(),
  /** { [sourceId]: { columns, rows, chartSpec } } captured at generate time (M4 byte-capped). */
  dataSnapshot: jsonb('data_snapshot').notNull(),
  generatedAt: timestamp('generated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  uniqueVersion: unique('report_versions_report_version_unique').on(t.reportId, t.version), // H6
}));
