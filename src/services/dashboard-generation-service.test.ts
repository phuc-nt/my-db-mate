/**
 * NL→dashboard generation: the LLM call and context are mocked; probes run
 * against a real SQLite connection so the pin-gate (checkWidgetSql) + trial-run
 * path are exercised for real. Covers: sql-XOR-useMetric resolution, probe gate
 * rejecting a bad query, metric-verbatim reuse, and fail-closed on all-fail.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import path from 'node:path';
import { rm, mkdir } from 'node:fs/promises';
import Database from 'better-sqlite3';
import { eq } from 'drizzle-orm';
import { db } from '../db/client';
import { connections } from '../db/schema';
import { metrics } from '../db/metric-schema';

const DB_PATH = path.join(process.cwd(), '.cache', 'gen-dashboard-test.sqlite');

// --- mock the LLM + context (probes stay real) ---
const mockOutput = vi.fn();
vi.mock('ai', async (orig) => {
  const actual = await orig<typeof import('ai')>();
  return { ...actual, generateText: async () => ({ output: mockOutput() }), Output: actual.Output };
});
vi.mock('./context-service', () => ({
  getRelevantContext: async () => ({
    tableAnnotations: [], columnAnnotations: [], glossaryHits: [], manualRelationships: [],
    verifiedExamples: [], metrics: [{ id: 'metric-x', name: 'Total sales', description: null, sql: 'SELECT SUM(amt) AS v FROM sales', dimensions: null, distance: 0.1 }],
  }),
}));
vi.mock('./schema-pruning-service', () => ({ getPrunedSchemaSummary: async () => 'sales(id, amt, region)' }));
vi.mock('./settings-service', () => ({ getLlmSettings: async () => ({ provider: 'anthropic' }) }));
vi.mock('./llm-service', () => ({ getModel: async () => ({}) }));

let connId: string;
let metricId: string;

beforeAll(async () => {
  await mkdir(path.dirname(DB_PATH), { recursive: true });
  await rm(DB_PATH, { force: true });
  const sqlite = new Database(DB_PATH);
  sqlite.exec('CREATE TABLE sales (id INTEGER, amt REAL, region TEXT); INSERT INTO sales VALUES (1, 10, \'N\'), (2, 20, \'S\'), (3, 30, \'N\');');
  sqlite.close();

  const [c] = await db.insert(connections).values({
    name: 'gen-test', kind: 'sqlite-file', dialect: 'sqlite', config: { path: DB_PATH },
    secretEncrypted: null, isReadOnlyVerified: true,
  }).returning({ id: connections.id });
  connId = c.id;

  const [m] = await db.insert(metrics).values({
    connectionId: connId, name: 'Total sales', sql: 'SELECT SUM(amt) AS v FROM sales', timeGrain: 'month',
  }).returning({ id: metrics.id });
  metricId = m.id;
});

afterAll(async () => {
  await db.delete(metrics).where(eq(metrics.connectionId, connId));
  await db.delete(connections).where(eq(connections.id, connId));
  await rm(DB_PATH, { force: true });
});

async function generate(widgets: unknown[]) {
  const { generateDashboardProposal } = await import('./dashboard-generation-service');
  mockOutput.mockReturnValue({ dashboardTitle: 'Sales', widgets });
  return generateDashboardProposal({ connectionId: connId, prompt: 'sales overview' });
}

describe('generateDashboardProposal', () => {
  it('probes a valid SQL widget as ok against real data', async () => {
    const r = await generate([{ title: 'By region', sql: 'SELECT region, SUM(amt) AS total FROM sales GROUP BY region', chartType: 'bar', x: 'region', y: 'total' }]);
    expect(r.ok).toBe(true);
    if (r.ok) { expect(r.widgets[0].probe.ok).toBe(true); expect(r.widgets[0].chartSpec).toBeTruthy(); }
  });

  it('reuses a governed metric SQL verbatim (useMetric)', async () => {
    const r = await generate([{ title: 'Total', useMetric: metricId }]);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.widgets[0].fromMetricId).toBe(metricId);
      expect(r.widgets[0].sql).toBe('SELECT SUM(amt) AS v FROM sales'); // unmodified
    }
  });

  it('marks a widget whose SQL is invalid as probe-failed but keeps others', async () => {
    const r = await generate([
      { title: 'Bad', sql: 'SELECT * FROM does_not_exist' },
      { title: 'Good', sql: 'SELECT region FROM sales GROUP BY region' },
    ]);
    expect(r.ok).toBe(true); // at least one passed
    if (r.ok) {
      const bad = r.widgets.find((w) => w.title === 'Bad');
      const good = r.widgets.find((w) => w.title === 'Good');
      expect(bad?.probe.ok).toBe(false);
      expect(good?.probe.ok).toBe(true);
    }
  });

  it('fail-closed when every widget fails to probe', async () => {
    const r = await generate([{ title: 'Bad', sql: 'SELECT * FROM nope' }]);
    expect(r.ok).toBe(false);
  });

  it('drops a widget that is neither sql nor a resolvable metric', async () => {
    const r = await generate([
      { title: 'Empty' },
      { title: 'Good', sql: 'SELECT region FROM sales GROUP BY region' },
    ]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.widgets.find((w) => w.title === 'Empty')).toBeUndefined();
  });
});

describe('acceptDashboardProposal', () => {
  it('creates a dashboard and pins the selected widgets', async () => {
    const { acceptDashboardProposal } = await import('./dashboard-generation-service');
    const r = await acceptDashboardProposal({
      connectionId: connId, dashboardTitle: 'Accepted',
      widgets: [{ title: 'W1', sql: 'SELECT region, SUM(amt) AS t FROM sales GROUP BY region', chartSpec: null }],
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.pinned).toBe(1);
      const { getDashboard, deleteDashboard } = await import('./dashboard-service');
      const d = await getDashboard(r.dashboardId);
      expect(d?.widgets.length).toBe(1);
      await deleteDashboard(r.dashboardId); // cleanup
    }
  });

  it('refuses iterate-append when the body connection differs from the dashboard', async () => {
    const { acceptDashboardProposal } = await import('./dashboard-generation-service');
    const { createDashboard, pinWidget, deleteDashboard } = await import('./dashboard-service');
    const dash = await createDashboard('conn-A dash');
    await pinWidget({ dashboardId: dash.id, connectionId: connId, title: 'seed', sql: 'SELECT region FROM sales GROUP BY region' });
    const r = await acceptDashboardProposal({
      connectionId: 'some-other-connection-id', dashboardTitle: '', existingDashboardId: dash.id,
      widgets: [{ title: 'X', sql: 'SELECT 1', chartSpec: null }],
    });
    expect(r.ok).toBe(false);
    await deleteDashboard(dash.id);
  });

  it('deletes the freshly-created dashboard when zero widgets pin (no orphan)', async () => {
    const { acceptDashboardProposal } = await import('./dashboard-generation-service');
    const { listDashboards } = await import('./dashboard-service');
    const before = (await listDashboards()).length;
    // A non-SELECT is rejected by the pin gate (validateSql), so it can never pin.
    const r = await acceptDashboardProposal({
      connectionId: connId, dashboardTitle: 'ShouldVanish',
      widgets: [{ title: 'Bad', sql: 'DELETE FROM sales', chartSpec: null }],
    });
    expect(r.ok).toBe(false);
    const after = (await listDashboards()).length;
    expect(after).toBe(before); // no orphan left behind
  });
});
