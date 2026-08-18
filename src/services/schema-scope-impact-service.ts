/**
 * What a scope change would break.
 *
 * Setting a boundary is a governance act with consequences for work that already
 * exists: a metric, a saved query, a pinned widget, or a schedule authored before
 * the boundary may read tables the boundary now withholds. Those artifacts are
 * not rewritten or deleted — the owner decides — but they are reported before the
 * change and, for anything that runs unattended, paused when the change lands.
 * A schedule that silently fails every night is worse than one that says why.
 *
 * Only artifacts holding live SQL are scanned, because only live SQL can be
 * re-checked at execution time. That is NOT the same as saying the rest are
 * harmless: a notebook or report snapshot holds ROWS captured before the
 * boundary existed, and a share slug serves those rows to an anonymous reader
 * with no scope check on the way out. Frozen data is exactly the thing a
 * narrowing is meant to withdraw, so snapshots are evicted when the scope
 * lands (see `evictImpactedSnapshots`) rather than reported here. Action
 * triggers fire on findings and issue no SQL of their own, so they hold nothing.
 */
import { and, eq, inArray, isNotNull, or } from 'drizzle-orm';
import { db } from '../db/client';
import { connections } from '../db/schema';
import { metrics } from '../db/metric-schema';
import { verifiedQueries } from '../db/context-schema';
import { dashboardWidgets } from '../db/dashboard-schema';
import { notebooks } from '../db/notebook-schema';
import { reportSources, reportVersions } from '../db/report-schema';
import { scheduledQueries } from '../db/ecosystem-schema';
import { extractScopeRefs } from '../lib/sql-scope-refs';
import { isRefInScope, isScopeActive, type SchemaScope } from './schema-scope-service';
import type { Dialect } from './connection-providers/provider-interface';

export type ImpactedKind = 'metric' | 'verified_query' | 'dashboard_widget' | 'schedule';

export interface ImpactedArtifact {
  kind: ImpactedKind;
  id: string;
  name: string;
  /** Table references that fall outside the proposed scope, or [] when the SQL
   *  could not be parsed (which the guard also blocks — reported as unverifiable). */
  offendingRefs: string[];
  /** True when the SQL could not be parsed, so it will be blocked at runtime
   *  regardless of which tables it names. */
  unparseable: boolean;
  /** Runs unattended, so it is auto-paused when the scope is applied. */
  scheduled: boolean;
}

/** One artifact's SQL against a proposed scope. Null when it stays in bounds. */
function checkSql(
  sql: string,
  dialect: Dialect,
  scope: SchemaScope,
  base: { kind: ImpactedKind; id: string; name: string; scheduled: boolean },
): ImpactedArtifact | null {
  const refs = extractScopeRefs(sql, dialect);
  if (refs === null) return { ...base, offendingRefs: [], unparseable: true };
  const offending = refs
    .filter((r) => !isRefInScope(scope, r))
    .map((r) => (r.schemaName ? `${r.schemaName}.${r.tableName}` : r.tableName));
  if (offending.length === 0) return null;
  return { ...base, offendingRefs: offending, unparseable: false };
}

/**
 * Every existing artifact that a proposed scope would block. Pure inspection —
 * changes nothing, so the UI can show it before the owner commits.
 */
export async function findImpactedArtifacts(
  connectionId: string,
  scope: SchemaScope | null,
): Promise<ImpactedArtifact[]> {
  if (!isScopeActive(scope)) return [];

  const [conn] = await db
    .select({ dialect: connections.dialect })
    .from(connections)
    .where(eq(connections.id, connectionId));
  if (!conn) return [];
  const dialect = conn.dialect as Dialect;

  const [metricRows, vqRows, widgetRows, scheduleRows] = await Promise.all([
    db.select({ id: metrics.id, name: metrics.name, sql: metrics.sql })
      .from(metrics).where(eq(metrics.connectionId, connectionId)),
    db.select({ id: verifiedQueries.id, name: verifiedQueries.question, sql: verifiedQueries.sql })
      .from(verifiedQueries).where(eq(verifiedQueries.connectionId, connectionId)),
    db.select({ id: dashboardWidgets.id, name: dashboardWidgets.title, sql: dashboardWidgets.sql })
      .from(dashboardWidgets).where(eq(dashboardWidgets.connectionId, connectionId)),
    db.select({ id: scheduledQueries.id, name: scheduledQueries.name, sql: scheduledQueries.sql })
      .from(scheduledQueries)
      .where(and(eq(scheduledQueries.connectionId, connectionId), isNotNull(scheduledQueries.sql))),
  ]);

  const out: ImpactedArtifact[] = [];
  const collect = (
    rows: { id: string; name: string; sql: string | null }[],
    kind: ImpactedKind,
    scheduled: boolean,
  ) => {
    for (const r of rows) {
      if (!r.sql) continue;
      const hit = checkSql(r.sql, dialect, scope, { kind, id: r.id, name: r.name, scheduled });
      if (hit) out.push(hit);
    }
  };

  collect(metricRows, 'metric', false);
  collect(vqRows, 'verified_query', false);
  collect(widgetRows, 'dashboard_widget', false);
  collect(scheduleRows, 'schedule', true);
  return out;
}

/**
 * Disable the schedules a scope change would break. Attended artifacts are left
 * alone: a metric that errors tells its owner immediately, while a nightly
 * schedule would just accumulate failures unseen. Returns the ids paused.
 */
export async function pauseImpactedSchedules(impacted: ImpactedArtifact[]): Promise<string[]> {
  const ids = impacted.filter((a) => a.scheduled).map((a) => a.id);
  for (const id of ids) {
    await db.update(scheduledQueries).set({ isEnabled: false }).where(eq(scheduledQueries.id, id));
  }
  return ids;
}

/**
 * Drop every cached row set that the new boundary would forbid.
 *
 * The guard covers execution, but a result captured BEFORE the narrowing is
 * already sitting in the database, and the read paths that serve it — a shared
 * dashboard, a notebook or report share slug — are anonymous and do not consult
 * the scope. Leaving those rows in place would make the boundary cosmetic for
 * exactly the audience least able to be trusted with them. So: widget caches for
 * impacted widgets, every notebook snapshot on the connection whose SQL now
 * strays, and any report version drawing on an impacted source.
 *
 * Snapshots are cleared, not the artifacts themselves — the owner keeps the
 * notebook, the prose, and the layout, and a refresh inside the new boundary
 * refills what is still permitted.
 */
export async function evictImpactedSnapshots(
  connectionId: string,
  scope: SchemaScope | null,
  impacted: ImpactedArtifact[],
): Promise<{ widgets: number; notebooks: number; reportVersions: number }> {
  if (!isScopeActive(scope)) return { widgets: 0, notebooks: 0, reportVersions: 0 };

  const [conn] = await db
    .select({ dialect: connections.dialect })
    .from(connections)
    .where(eq(connections.id, connectionId));
  const dialect = (conn?.dialect ?? 'postgres') as Dialect;

  // Widgets: the impact scan already named them; clear the cached rows the
  // share page would otherwise serve.
  const widgetIds = impacted.filter((a) => a.kind === 'dashboard_widget').map((a) => a.id);
  if (widgetIds.length > 0) {
    await db.update(dashboardWidgets).set({ lastResult: null })
      .where(inArray(dashboardWidgets.id, widgetIds));
  }

  // Notebooks: a saved session's per-turn SQL lives in its markdown, so the
  // snapshot is judged as a whole — if any SQL in the notebook now strays, the
  // captured rows go. Coarse on purpose: a partial wipe would leave numbers on
  // the page whose provenance no longer resolves.
  const nbRows = await db
    .select({ id: notebooks.id, markdown: notebooks.markdown })
    .from(notebooks)
    .where(eq(notebooks.connectionId, connectionId));
  const staleNotebooks = nbRows.filter((n) => notebookStrays(n.markdown, dialect, scope)).map((n) => n.id);
  if (staleNotebooks.length > 0) {
    await db.update(notebooks).set({ dataSnapshot: {} })
      .where(inArray(notebooks.id, staleNotebooks));
  }

  // Reports carry no connection of their own; they reach one through their
  // sources. A version whose source is an impacted widget or saved query has
  // out-of-scope rows frozen into its snapshot.
  const vqIds = impacted.filter((a) => a.kind === 'verified_query').map((a) => a.id);
  let versionCount = 0;
  if (widgetIds.length > 0 || vqIds.length > 0 || staleNotebooks.length > 0) {
    const srcRows = await db
      .select({ reportId: reportSources.reportId })
      .from(reportSources)
      .where(or(
        widgetIds.length ? inArray(reportSources.widgetId, widgetIds) : undefined,
        vqIds.length ? inArray(reportSources.verifiedQueryId, vqIds) : undefined,
        staleNotebooks.length ? inArray(reportSources.notebookId, staleNotebooks) : undefined,
      ));
    const reportIds = [...new Set(srcRows.map((r) => r.reportId))];
    if (reportIds.length > 0) {
      const updated = await db.update(reportVersions).set({ dataSnapshot: {} })
        .where(inArray(reportVersions.reportId, reportIds))
        .returning({ id: reportVersions.id });
      versionCount = updated.length;
    }
  }

  return { widgets: widgetIds.length, notebooks: staleNotebooks.length, reportVersions: versionCount };
}

/** Does any SQL block inside a saved notebook fall outside the proposed scope?
 *  Unparseable blocks count as straying, matching the guard's fail-closed rule. */
function notebookStrays(markdown: string, dialect: Dialect, scope: SchemaScope): boolean {
  const blocks = [...markdown.matchAll(/```sql\s*([\s\S]*?)```/gi)].map((m) => m[1].trim());
  for (const sql of blocks) {
    if (!sql) continue;
    const refs = extractScopeRefs(sql, dialect);
    if (refs === null) return true;
    if (refs.some((r) => !isRefInScope(scope, r))) return true;
  }
  return false;
}
