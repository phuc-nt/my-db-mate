/**
 * Cached rows are withdrawn when the boundary narrows.
 *
 * Blocking future queries is only half of a narrowing. Results captured under
 * the old boundary are already stored — in a widget's cache, a notebook's
 * snapshot, a report version — and the pages that serve them (share slugs,
 * shared dashboards) are anonymous and never consult the scope. If those rows
 * survived, the boundary would hold for the owner and leak for everyone else.
 *
 * The other half of the contract matters just as much: caches for artifacts
 * that stay in bounds are left alone, so setting a scope is not a cache purge.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { resolve } from 'node:path';
import { db } from '@/core/db/client';
import { connections, schemaTables } from '@/core/db/schema';
import { dashboards, dashboardWidgets } from '@/core/db/dashboard-schema';
import { notebooks } from '@/core/db/notebook-schema';
import { reports, reportSources, reportVersions } from '@/core/db/report-schema';
import { evictImpactedSnapshots, findImpactedArtifacts } from './schema-scope-impact-service';

const DB_PATH = resolve(process.cwd(), '.testdata/scope-governance.sqlite');
const MART_ONLY = { tables: ['mart_orders'] };
const SECRET = [['123-45-6789']];

let connId: string;
let reportId: string;
let dashboardId: string;

afterEach(async () => {
  if (reportId) await db.delete(reports).where(eq(reports.id, reportId));
  if (connId) await db.delete(connections).where(eq(connections.id, connId));
  // Dashboards do not cascade from the connection — widgets do, the board does not.
  if (dashboardId) await db.delete(dashboards).where(eq(dashboards.id, dashboardId));
});

/** A connection carrying one in-bounds and one out-of-bounds cached artifact. */
async function seed() {
  const [c] = await db.insert(connections).values({
    name: 'scope-eviction-test', kind: 'sqlite-file', dialect: 'sqlite',
    config: { path: DB_PATH }, secretEncrypted: null, isReadOnlyVerified: true,
  }).returning({ id: connections.id });
  connId = c.id;
  for (const tableName of ['mart_orders', 'raw_pii']) {
    await db.insert(schemaTables).values({ connectionId: connId, tableName, schemaName: null, rowCount: 1 });
  }

  // A dashboard is connection-agnostic; each widget carries its own connection.
  const [dash] = await db.insert(dashboards).values({ name: 'scope-eviction-test' })
    .returning({ id: dashboards.id });
  dashboardId = dash.id;
  const [keep] = await db.insert(dashboardWidgets).values({
    connectionId: connId, dashboardId: dash.id, title: 'in scope',
    sql: 'SELECT region FROM mart_orders', lastResult: { columns: ['region'], rows: [['north']] },
  }).returning({ id: dashboardWidgets.id });
  const [leaky] = await db.insert(dashboardWidgets).values({
    connectionId: connId, dashboardId: dash.id, title: 'leaky',
    sql: 'SELECT ssn FROM raw_pii', lastResult: { columns: ['ssn'], rows: SECRET },
  }).returning({ id: dashboardWidgets.id });

  const [nb] = await db.insert(notebooks).values({
    connectionId: connId, title: 'nb',
    markdown: 'who earns most?\n```sql\nSELECT ssn FROM raw_pii\n```\n',
    dataSnapshot: { turn1: { columns: ['ssn'], rows: SECRET } },
  }).returning({ id: notebooks.id });

  const [rep] = await db.insert(reports).values({ title: 'r' }).returning({ id: reports.id });
  reportId = rep.id;
  await db.insert(reportSources).values({ reportId: rep.id, widgetId: leaky.id, position: 0 });
  const [ver] = await db.insert(reportVersions).values({
    reportId: rep.id, version: 1, markdown: 'narrative',
    dataSnapshot: { src1: { columns: ['ssn'], rows: SECRET } },
  }).returning({ id: reportVersions.id });

  return { keepId: keep.id, leakyId: leaky.id, notebookId: nb.id, versionId: ver.id };
}

describe('narrowing a scope withdraws the rows it forbids', () => {
  it('clears out-of-scope caches and keeps in-scope ones', async () => {
    const { keepId, leakyId, notebookId, versionId } = await seed();

    const impacted = await findImpactedArtifacts(connId, MART_ONLY);
    expect(impacted.map((a) => a.name)).toEqual(['leaky']);

    const counts = await evictImpactedSnapshots(connId, MART_ONLY, impacted);
    expect(counts).toEqual({ widgets: 1, notebooks: 1, reportVersions: 1 });

    const [keep] = await db.select().from(dashboardWidgets).where(eq(dashboardWidgets.id, keepId));
    const [leaky] = await db.select().from(dashboardWidgets).where(eq(dashboardWidgets.id, leakyId));
    const [nb] = await db.select().from(notebooks).where(eq(notebooks.id, notebookId));
    const [ver] = await db.select().from(reportVersions).where(eq(reportVersions.id, versionId));

    // The share pages read exactly these columns, so this is the leak surface.
    expect(leaky.lastResult).toBeNull();
    expect(nb.dataSnapshot).toEqual({});
    expect(ver.dataSnapshot).toEqual({});
    expect(JSON.stringify([leaky.lastResult, nb.dataSnapshot, ver.dataSnapshot])).not.toContain('123-45-6789');

    // Untouched: the artifact never left the boundary.
    expect(keep.lastResult).toEqual({ columns: ['region'], rows: [['north']] });
  });

  it('changes nothing when the scope is cleared', async () => {
    const { leakyId } = await seed();
    const counts = await evictImpactedSnapshots(connId, null, []);
    expect(counts).toEqual({ widgets: 0, notebooks: 0, reportVersions: 0 });
    const [leaky] = await db.select().from(dashboardWidgets).where(eq(dashboardWidgets.id, leakyId));
    expect(leaky.lastResult).not.toBeNull();
  });
});
