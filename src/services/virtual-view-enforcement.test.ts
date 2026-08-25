/**
 * Curated views end-to-end, through the real executor against a real database.
 *
 * Two properties are being defended. First, the view has to actually WORK: a
 * question asked in business language must return the same numbers as the
 * hand-written query, or the curated layer is worse than useless. Second,
 * `viewsOnly` has to mean what it says — the curated layer is the interface,
 * and a raw table cannot be reached past it even when the governed scope would
 * otherwise admit that table.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { resolve } from 'node:path';
import { db } from '@/core/db/client';
import { connections, schemaTables } from '@/core/db/schema';
import { executeQuery } from './query-executor-service';
import { setScope } from './schema-scope-service';
import { createView, invalidateViewCache, updateView, VirtualViewError } from './virtual-view-service';

const DB_PATH = resolve(process.cwd(), '.testdata/scope-governance.sqlite');
const VIEW_SQL = "SELECT region, ROUND(SUM(revenue),2) AS revenue FROM mart_orders WHERE status='P' GROUP BY region";

let connId: string;
const run = (sql: string) => executeQuery({ connectionId: connId, sql, confirmed: true });

beforeAll(async () => {
  const [c] = await db.insert(connections).values({
    name: 'virtual-view-test', kind: 'sqlite-file', dialect: 'sqlite',
    config: { path: DB_PATH }, secretEncrypted: null, isReadOnlyVerified: true,
  }).returning({ id: connections.id });
  connId = c.id;
  for (const tableName of ['mart_orders', 'mart_customers', 'raw_pii', 'raw_events']) {
    await db.insert(schemaTables).values({ connectionId: connId, tableName, schemaName: null, rowCount: 100 });
  }
  await createView({
    connectionId: connId, name: 'doanh_thu_theo_vung',
    description: 'Revenue by region, paid orders only', sql: VIEW_SQL,
  });
  invalidateViewCache(connId);
});

afterAll(async () => {
  await db.delete(connections).where(eq(connections.id, connId));
});

describe('a curated view answers in business language', () => {
  beforeAll(async () => { await setScope(connId, null); });

  it('returns exactly what the underlying query returns', async () => {
    const viaView = await run('SELECT * FROM doanh_thu_theo_vung ORDER BY region');
    const direct = await run(`SELECT * FROM (${VIEW_SQL}) AS x ORDER BY region`);
    expect(viaView.status).toBe('ok');
    expect(viaView.result!.rows).toEqual(direct.result!.rows);
    expect(viaView.result!.rows.length).toBe(4);
  });

  it('can be composed over, not just selected from', async () => {
    const res = await run('SELECT COUNT(*) AS n, ROUND(SUM(revenue),2) AS total FROM doanh_thu_theo_vung');
    expect(res.status).toBe('ok');
    expect(Number(res.result!.rows[0][0])).toBe(4);
    expect(Number(res.result!.rows[0][1])).toBeGreaterThan(0);
  });

  it('probes and caches the column list at save time', async () => {
    const v = await updateView({ connectionId: connId, id: (await currentViewId()), description: 'edited' });
    expect(v.columnsCache?.map((c) => c.name)).toEqual(['region', 'revenue']);
  });
});

describe('viewsOnly makes the curated layer the whole interface', () => {
  beforeAll(async () => {
    // mart_orders IS inside the governed scope — the point being that viewsOnly
    // withholds it anyway, because it was not reached through a curated view.
    await setScope(connId, { tables: ['mart_orders'], viewsOnly: true });
    invalidateViewCache(connId);
  });
  afterAll(async () => { await setScope(connId, null); });

  it('serves the view', async () => {
    const res = await run('SELECT * FROM doanh_thu_theo_vung ORDER BY region');
    expect(res.status).toBe('ok');
    expect(res.result!.rows.length).toBe(4);
  });

  it('refuses a raw table even when the scope admits it', async () => {
    const res = await run('SELECT COUNT(*) FROM mart_orders');
    expect(res.status).toBe('blocked');
    expect(res.blockedReason).toMatch(/governed views/i);
    expect(res.blockedReason).toContain('doanh_thu_theo_vung');
  });

  it('refuses a table that is outside the scope as well', async () => {
    const res = await run('SELECT ssn FROM raw_pii');
    expect(res.status).toBe('blocked');
    expect(res.result).toBeUndefined();
  });

  it('refuses a CTE that would shadow a governed view', async () => {
    const res = await run('WITH doanh_thu_theo_vung AS (SELECT 1 AS revenue) SELECT * FROM doanh_thu_theo_vung');
    expect(res.status).toBe('blocked');
    expect(res.blockedReason).toMatch(/shadow/i);
  });

  it('refuses a raw table hidden in a subquery', async () => {
    const res = await run('SELECT * FROM doanh_thu_theo_vung WHERE region IN (SELECT region FROM raw_events)');
    expect(res.status).toBe('blocked');
  });
});

describe('a definition is validated before it can be saved', () => {
  it('rejects SQL that the safety layer blocks', async () => {
    await expect(createView({
      connectionId: connId, name: 'bad_write', sql: 'DELETE FROM mart_orders',
    })).rejects.toBeInstanceOf(VirtualViewError);
  });

  it('rejects a name that collides with a real table', async () => {
    await expect(createView({
      connectionId: connId, name: 'mart_orders', sql: 'SELECT 1 AS x',
    })).rejects.toThrow(/real table/i);
  });

  it('rejects a view built on another view', async () => {
    await expect(createView({
      connectionId: connId, name: 'derived', sql: 'SELECT * FROM doanh_thu_theo_vung',
    })).rejects.toThrow(/cannot build on another view/i);
  });

  it('rejects a name that is not snake_case', async () => {
    await expect(createView({
      connectionId: connId, name: 'Bad Name!', sql: 'SELECT 1 AS x',
    })).rejects.toThrow(/snake_case/i);
  });

  it('rejects SQL outside the governed scope', async () => {
    await setScope(connId, { tables: ['mart_orders'] });
    await expect(createView({
      connectionId: connId, name: 'leaky_view', sql: 'SELECT ssn FROM raw_pii',
    })).rejects.toThrow(/governed scope/i);
    await setScope(connId, null);
  });
});

async function currentViewId(): Promise<string> {
  const { listViews } = await import('./virtual-view-service');
  const [v] = await listViews(connId);
  return v.id;
}
