/**
 * Dashboard service (P2). CRUD for dashboards/widgets, owner-side widget refresh,
 * and the read-only share lookup.
 *
 * Red-team trust model:
 * - Pinning validates the SQL through safety, assesses + stores the risk tier, and
 *   blocks a query that touches sensitive columns (C4/H2).
 * - runWidget is OWNER-only: it runs through the query-executor choke point WITHOUT
 *   auto-confirming medium risk (owner-in-loop), and caches the result.
 * - getSharedDashboard returns ONLY cached results (never `sql`, never executes) so
 *   an anonymous viewer cannot trigger a query or read the SQL (H1/H2).
 */
import { generateShareSlug } from '../lib/share';
import { asc, eq } from 'drizzle-orm';
import { db } from '../db/client';
import { dashboards, dashboardWidgets } from '../db/dashboard-schema';
import { connections } from '../db/schema';
import { getConnection } from './connection-service';
import { buildProvider, type ConnectionRow } from './connection-providers/provider-factory';
import { validateSql } from './safety/safety-service';
import { validateChartSpec } from './chart-spec-service';
import { assessRisk } from './risk-scoring-service';
import { executeQuery, touchesSensitiveColumns, connectionHasSensitiveColumns } from './query-executor-service';
import type { Dialect } from './connection-providers/provider-interface';

const LAST_RESULT_ROW_CAP = 500;

export async function listDashboards() {
  const rows = await db.select().from(dashboards).orderBy(asc(dashboards.createdAt));
  // Derived for the Library: which connections feed each dashboard (via widgets).
  // A dashboard has no connection column — widgets do, and may span several DBs.
  const pairs = await db.select({ dashboardId: dashboardWidgets.dashboardId, name: connections.name })
    .from(dashboardWidgets)
    .innerJoin(connections, eq(connections.id, dashboardWidgets.connectionId));
  const byDash = new Map<string, Set<string>>();
  for (const p of pairs) {
    if (!byDash.has(p.dashboardId)) byDash.set(p.dashboardId, new Set());
    byDash.get(p.dashboardId)!.add(p.name);
  }
  return rows.map((r) => ({ ...r, connectionNames: [...(byDash.get(r.id) ?? [])] }));
}

export async function createDashboard(name: string) {
  const [row] = await db.insert(dashboards).values({ name }).returning();
  return row;
}

export async function getDashboard(id: string) {
  const [dash] = await db.select().from(dashboards).where(eq(dashboards.id, id));
  if (!dash) return null;
  const widgets = await db.select().from(dashboardWidgets)
    .where(eq(dashboardWidgets.dashboardId, id))
    .orderBy(asc(dashboardWidgets.position), asc(dashboardWidgets.createdAt));
  return { ...dash, widgets };
}

export async function renameDashboard(id: string, name: string) {
  await db.update(dashboards).set({ name, updatedAt: new Date() }).where(eq(dashboards.id, id));
}

export async function deleteDashboard(id: string) {
  await db.delete(dashboards).where(eq(dashboards.id, id)); // widgets cascade
}

/** Generate (or regenerate = revoke old) a 128-bit share slug. null clears sharing. */
export async function setShare(id: string, enable: boolean): Promise<string | null> {
  const slug = enable ? generateShareSlug() : null;
  await db.update(dashboards).set({ shareSlug: slug, updatedAt: new Date() }).where(eq(dashboards.id, id));
  return slug;
}

export interface PinInput {
  dashboardId: string;
  connectionId: string;
  title: string;
  sql: string;
  chartSpec?: unknown;
}

export type PinResult =
  | { ok: true; widgetId: string }
  | { ok: false; reason: string };

/**
 * Pin a query as a widget. Validates SQL through safety, blocks sensitive-column
 * queries (C4), assesses + stores the risk tier (H2), and stores a re-validated
 * chart spec. Does NOT run the query — the owner refreshes it afterwards.
 */
export async function pinWidget(input: PinInput): Promise<PinResult> {
  const conn = await getConnection(input.connectionId);
  if (!conn) return { ok: false, reason: 'Connection not found' };

  const verdict = validateSql(input.sql, conn.dialect as Dialect);
  if (verdict.status === 'blocked') return { ok: false, reason: `Unsafe query: ${verdict.reason}` };

  // C4: never let a query over sensitive columns become a shareable widget.
  if (await touchesSensitiveColumns(input.connectionId, verdict.sql)) {
    return { ok: false, reason: 'This query reads a column marked sensitive — it cannot be pinned to a shareable dashboard.' };
  }
  // C4 (review M1): a `SELECT *` never names its columns, so the name-match above
  // can't see a sensitive column it expands to. When the connection has ANY
  // sensitive column, reject a wildcard select rather than risk leaking one.
  if (/\bselect\s+\*/i.test(verdict.sql) && (await connectionHasSensitiveColumns(input.connectionId))) {
    return { ok: false, reason: 'This connection has sensitive columns — pin an explicit column list instead of SELECT * so no sensitive value is shared by accident.' };
  }

  // Capture the risk tier now so the owner-refresh path can honor it (H2).
  const provider = buildProvider(conn as unknown as ConnectionRow);
  let riskTier = 'low';
  try {
    const risk = await assessRisk(provider, verdict.sql, { sensitiveColumnsTouched: false });
    riskTier = risk.tier;
  } catch { /* leave low; refresh will re-gate */ } finally {
    await provider.close();
  }

  const chartSpec = validateChartSpec(input.chartSpec) ?? null;

  const [row] = await db.insert(dashboardWidgets).values({
    dashboardId: input.dashboardId,
    connectionId: input.connectionId,
    title: input.title,
    sql: verdict.sql,
    chartSpec,
    riskTier,
  }).returning({ id: dashboardWidgets.id });
  return { ok: true, widgetId: row.id };
}

export async function deleteWidget(id: string) {
  await db.delete(dashboardWidgets).where(eq(dashboardWidgets.id, id));
}

export type RefreshResult =
  | { status: 'ok'; columns: string[]; rows: unknown[][]; refreshedAt: string }
  | { status: 'blocked' | 'error' | 'needs_confirmation'; message: string; risk?: { tier: string; score: number; reason: string } };

/**
 * OWNER-side widget refresh. Runs through the query-executor choke point WITHOUT
 * auto-confirming medium risk — the owner stays in the loop. On success the result
 * is cached so the share view can render it without any execution.
 */
export async function runWidget(widgetId: string, confirmed = false): Promise<RefreshResult> {
  const [w] = await db.select().from(dashboardWidgets).where(eq(dashboardWidgets.id, widgetId));
  if (!w) return { status: 'error', message: 'Widget not found' };

  const res = await executeQuery({ connectionId: w.connectionId, sql: w.sql, actor: 'dashboard', confirmed });
  if (res.status === 'blocked') return { status: 'blocked', message: res.blockedReason ?? 'blocked' };
  if (res.status === 'needs_confirmation') return { status: 'needs_confirmation', message: 'This widget is estimated as medium-risk. Confirm to run it.', risk: res.risk };
  if (res.status === 'error') return { status: 'error', message: res.errorMessage ?? 'error' };

  const rows = (res.result!.rows ?? []).slice(0, LAST_RESULT_ROW_CAP);
  const refreshedAt = new Date();
  await db.update(dashboardWidgets)
    .set({ lastResult: { columns: res.result!.columns, rows }, lastRefreshedAt: refreshedAt })
    .where(eq(dashboardWidgets.id, widgetId));
  return { status: 'ok', columns: res.result!.columns, rows, refreshedAt: refreshedAt.toISOString() };
}

/**
 * Read-only share view. Returns cached results ONLY — no `sql`, no execution (H1/H2).
 * A viewer with the slug can read the last owner-refreshed snapshot, nothing more.
 */
export async function getSharedDashboard(slug: string) {
  const [dash] = await db.select().from(dashboards).where(eq(dashboards.shareSlug, slug));
  if (!dash) return null;
  const widgets = await db.select({
    id: dashboardWidgets.id,
    title: dashboardWidgets.title,
    chartSpec: dashboardWidgets.chartSpec,
    lastResult: dashboardWidgets.lastResult,
    lastRefreshedAt: dashboardWidgets.lastRefreshedAt,
    position: dashboardWidgets.position,
  }).from(dashboardWidgets)
    .where(eq(dashboardWidgets.dashboardId, dash.id))
    .orderBy(asc(dashboardWidgets.position), asc(dashboardWidgets.createdAt));
  return { id: dash.id, name: dash.name, widgets };
}
