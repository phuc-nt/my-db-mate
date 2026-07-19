/**
 * AI widget edit: LLM mocked, gate/probe/apply REAL against a SQLite fixture.
 * The fixture marks sales.amt as sensitive (columnAnnotations.isSensitive) so
 * the sensitive-refusal test is meaningful — a fixture without any sensitive
 * column would let that test pass vacuously (the V2-review trap).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import path from 'node:path';
import { rm, mkdir } from 'node:fs/promises';
import Database from 'better-sqlite3';
import { and, eq } from 'drizzle-orm';
import { db } from '../db/client';
import { connections } from '../db/schema';
import { columnAnnotations } from '../db/context-schema';
import { dashboards, dashboardWidgets } from '../db/dashboard-schema';

const DB_PATH = path.join(process.cwd(), '.cache', 'widget-edit-test.sqlite');

const mockOutput = vi.fn();
vi.mock('ai', async (orig) => {
  const actual = await orig<typeof import('ai')>();
  return { ...actual, generateText: async () => ({ output: mockOutput() }), Output: actual.Output };
});
vi.mock('./schema-pruning-service', () => ({ getPrunedSchemaSummary: async () => 'sales(id, amt, region, order_date)' }));
vi.mock('./settings-service', () => ({ getLlmSettings: async () => ({ provider: 'anthropic' }) }));
vi.mock('./llm-service', () => ({ getModel: async () => ({}) }));

let connId: string;
let dashId: string;
let widgetId: string;

async function makeWidget(sql: string): Promise<string> {
  const [row] = await db.insert(dashboardWidgets).values({
    dashboardId: dashId, connectionId: connId, title: 'W', sql, riskTier: 'low',
    lastResult: { columns: ['region'], rows: [['N']] }, lastRefreshedAt: new Date(),
  }).returning({ id: dashboardWidgets.id });
  return row.id;
}

beforeAll(async () => {
  await mkdir(path.dirname(DB_PATH), { recursive: true });
  await rm(DB_PATH, { force: true });
  const sqlite = new Database(DB_PATH);
  sqlite.exec("CREATE TABLE sales (id INTEGER, amt REAL, region TEXT, order_date TEXT); INSERT INTO sales VALUES (1,10,'N','2026-01-02'),(2,20,'S','2026-02-03'),(3,30,'N','2026-03-04');");
  sqlite.close();

  const [c] = await db.insert(connections).values({
    name: 'widget-edit-test', kind: 'sqlite-file', dialect: 'sqlite', config: { path: DB_PATH },
    secretEncrypted: null, isReadOnlyVerified: true,
  }).returning({ id: connections.id });
  connId = c.id;
  // Meaningful sensitive fixture: amt is sensitive.
  await db.insert(columnAnnotations).values({ connectionId: connId, tableName: 'sales', columnName: 'amt', description: null, businessAlias: null, isSensitive: true });

  const [d] = await db.insert(dashboards).values({ name: 'edit-test-dash' }).returning({ id: dashboards.id });
  dashId = d.id;
  widgetId = await makeWidget('SELECT region, COUNT(*) AS orders FROM sales GROUP BY region');
});

afterAll(async () => {
  await db.delete(dashboardWidgets).where(eq(dashboardWidgets.dashboardId, dashId));
  await db.delete(dashboards).where(eq(dashboards.id, dashId));
  await db.delete(columnAnnotations).where(eq(columnAnnotations.connectionId, connId));
  await db.delete(connections).where(eq(connections.id, connId));
  await rm(DB_PATH, { force: true });
});

describe('proposeWidgetEdit', () => {
  it('valid edit → probe passes; placeholder warning absent', async () => {
    const { proposeWidgetEdit } = await import('./widget-edit-service');
    mockOutput.mockReturnValue({ sql: 'SELECT region, COUNT(*) AS orders FROM sales GROUP BY region ORDER BY orders DESC LIMIT 1', rationale: 'top region' });
    const r = await proposeWidgetEdit({ widgetId, instruction: 'top region only' });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.proposal.probe.ok).toBe(true);
      expect(r.proposal.warnings).toEqual([]);
    }
  });

  it('LLM returns non-SELECT → probe fails (gate)', async () => {
    const { proposeWidgetEdit } = await import('./widget-edit-service');
    mockOutput.mockReturnValue({ sql: 'DELETE FROM sales' });
    const r = await proposeWidgetEdit({ widgetId, instruction: 'nuke it' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.proposal.probe.ok).toBe(false);
  });

  it('warns when the edit drops {{from}}/{{to}} placeholders', async () => {
    const { proposeWidgetEdit } = await import('./widget-edit-service');
    const paramWidget = await makeWidget("SELECT region FROM sales WHERE order_date BETWEEN {{from}} AND {{to}} GROUP BY region");
    mockOutput.mockReturnValue({ sql: 'SELECT region FROM sales GROUP BY region' });
    const r = await proposeWidgetEdit({ widgetId: paramWidget, instruction: 'all time' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.proposal.warnings.length).toBe(1);
  });
});

describe('applyWidgetEdit (updateWidgetSql, run-before-swap)', () => {
  it('sensitive SQL is refused and the widget row is fully intact', async () => {
    const { applyWidgetEdit } = await import('./widget-edit-service');
    const [before] = await db.select().from(dashboardWidgets).where(eq(dashboardWidgets.id, widgetId));
    const r = await applyWidgetEdit({ widgetId, sql: 'SELECT amt FROM sales' });
    expect(r.status).toBe('blocked');
    const [after] = await db.select().from(dashboardWidgets).where(eq(dashboardWidgets.id, widgetId));
    expect(after.sql).toBe(before.sql);
    expect(after.lastResult).toEqual(before.lastResult);
  });

  it('valid apply swaps sql + lastResult in one update (confirm flow when medium-risk)', async () => {
    const { applyWidgetEdit } = await import('./widget-edit-service');
    const newSql = 'SELECT region, COUNT(*) AS orders FROM sales GROUP BY region ORDER BY orders DESC';
    // Mirror the modal: a medium-risk estimate returns needs_confirmation with
    // NOTHING swapped; the owner confirms and the apply retries confirmed.
    let r = await applyWidgetEdit({ widgetId, sql: newSql });
    if (r.status === 'needs_confirmation') {
      const [mid] = await db.select().from(dashboardWidgets).where(eq(dashboardWidgets.id, widgetId));
      expect(mid.sql).not.toContain('ORDER BY'); // untouched before confirm
      r = await applyWidgetEdit({ widgetId, sql: newSql, confirmed: true });
    }
    expect(r.status).toBe('ok');
    const [after] = await db.select().from(dashboardWidgets).where(eq(dashboardWidgets.id, widgetId));
    expect(after.sql).toContain('ORDER BY');
    const lr = after.lastResult as { columns: string[]; rows: unknown[][] };
    expect(lr.columns).toEqual(['region', 'orders']);
    expect(lr.rows.length).toBe(2); // N + S
  });

  it('parametrized SQL keeps raw placeholders in the stored row', async () => {
    const { applyWidgetEdit } = await import('./widget-edit-service');
    const paramWidget = await makeWidget('SELECT region FROM sales GROUP BY region');
    let r = await applyWidgetEdit({ widgetId: paramWidget, sql: "SELECT region, COUNT(*) AS c FROM sales WHERE order_date BETWEEN {{from}} AND {{to}} GROUP BY region" });
    if (r.status === 'needs_confirmation') r = await applyWidgetEdit({ widgetId: paramWidget, sql: "SELECT region, COUNT(*) AS c FROM sales WHERE order_date BETWEEN {{from}} AND {{to}} GROUP BY region", confirmed: true });
    expect(r.status).toBe('ok');
    const [after] = await db.select().from(dashboardWidgets).where(eq(dashboardWidgets.id, paramWidget));
    expect(after.sql).toContain('{{from}}');
  });

  it('fingerprint: a swap against a stale sql matches nothing (mechanism)', async () => {
    // The WHERE (id, sql=oldSql) clause is the concurrency guard; prove the
    // mechanism — an update conditioned on a sql the row no longer holds is a no-op.
    const res = await db.update(dashboardWidgets)
      .set({ title: 'should-not-apply' })
      .where(and(eq(dashboardWidgets.id, widgetId), eq(dashboardWidgets.sql, 'SQL THAT IS NOT THERE')))
      .returning({ id: dashboardWidgets.id });
    expect(res.length).toBe(0);
  });
});
