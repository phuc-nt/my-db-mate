/**
 * The resolution requirement, isolated.
 *
 * Every reference must name a table the sync actually found, on top of being
 * inside the scope. That second condition is what the other suites exercise;
 * this one exercises the first, using the case where the two come apart: a
 * reference that passes the scope check on its face while naming nothing real.
 *
 * BigQuery is the dialect under test because it is the one that still splits a
 * dotted identifier into dataset + table, so a quoted name containing a dot is
 * read as `<granted dataset>.<attacker's table>` and sails through a dataset
 * grant. The scope check cannot catch that — the dataset genuinely IS granted.
 * Only asking "does this table exist?" catches it.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '@/core/db/client';
import { connections, schemaTables } from '@/core/db/schema';
import { assertSqlInScope, setScope } from '@/core/boundary/schema-scope-service';

let connId: string;

const check = (sql: string) =>
  assertSqlInScope({ connectionId: connId, sql, dialect: 'bigquery' });

beforeAll(async () => {
  const [c] = await db.insert(connections).values({
    name: 'scope-resolution-test', kind: 'bigquery', dialect: 'bigquery',
    config: { projectId: 'test-project' }, secretEncrypted: null, isReadOnlyVerified: true,
  }).returning({ id: connections.id });
  connId = c.id;

  // The sync found exactly one table, in the dataset that will be granted.
  await db.insert(schemaTables).values([
    { connectionId: connId, tableName: 'orders', schemaName: 'mart_orders', rowCount: 10 },
    { connectionId: connId, tableName: 'salaries', schemaName: 'hr_private', rowCount: 5 },
  ]);
  await setScope(connId, { datasets: ['mart_orders'] });
});

afterAll(async () => {
  await db.delete(connections).where(eq(connections.id, connId));
});

describe('a reference must resolve to a synced table', () => {
  it('admits a real table in the granted dataset', async () => {
    expect((await check('SELECT * FROM mart_orders.orders')).status).toBe('ok');
  });

  it('blocks a fabricated table that a dataset grant would otherwise admit', async () => {
    // Reads as dataset `mart_orders` (granted!) + table `raw_pii_leak`. The
    // scope check says yes; the table does not exist, so the guard says no.
    const v = await check('SELECT * FROM "mart_orders.raw_pii_leak"');
    expect(v.status).toBe('blocked');
    expect(v.status === 'blocked' && v.reason).toMatch(/synced schema/i);
  });

  it('still blocks a real table outside the granted dataset', async () => {
    // Resolution passes here — the table is real — so the scope check is what
    // must refuse it. Both conditions are load-bearing.
    const v = await check('SELECT * FROM hr_private.salaries');
    expect(v.status).toBe('blocked');
    expect(v.status === 'blocked' && v.reason).toMatch(/scope/i);
  });

  it('admits a statement that reads no table at all', async () => {
    expect((await check('SELECT 1')).status).toBe('ok');
  });
});
