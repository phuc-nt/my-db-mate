/**
 * The advisor's evidence of real usage, read from the app's own audit trail.
 *
 * This reader exists because BigQuery will not hand over its statement log, so
 * the only usage evidence available is the one my-db-mate recorded itself. Two
 * properties decide whether that evidence is worth designing a datamart around,
 * and both are asserted here against a real app database: only SUCCESSFUL runs
 * count (a blocked query says what someone tried, not what the data supports),
 * and shapes are counted after literals are stripped (otherwise one daily report
 * run with a hundred dates looks like a hundred unrelated one-off queries and
 * drowns out the pattern that actually matters).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '../db/client';
import { connections, queryRuns } from '../db/schema';
import { mineQueryRuns } from './query-runs-mining-reader';

let connId: string;
let otherConnId: string;

const newConnection = async (name: string) => {
  const [c] = await db.insert(connections).values({
    name, kind: 'sqlite-file', dialect: 'sqlite',
    config: { path: '/nonexistent.sqlite' }, secretEncrypted: null, isReadOnlyVerified: true,
  }).returning({ id: connections.id });
  return c.id;
};

const log = (connectionId: string, sql: string, status: string) =>
  db.insert(queryRuns).values({ connectionId, sql, status });

beforeAll(async () => {
  connId = await newConnection('mining-reader-test');
  otherConnId = await newConnection('mining-reader-test-other');

  // One shape, three different date literals — one real pattern, run often.
  await log(connId, "SELECT region, SUM(revenue) FROM orders WHERE day = '2026-01-01' GROUP BY region", 'ok');
  await log(connId, "SELECT region, SUM(revenue) FROM orders WHERE day = '2026-01-02' GROUP BY region", 'ok');
  await log(connId, "SELECT region, SUM(revenue) FROM orders WHERE day = '2026-01-03' GROUP BY region", 'ok');
  // A distinct shape, run once.
  await log(connId, 'SELECT id FROM customers', 'ok');
  // Never-successful statements: refused by the guard, or errored.
  await log(connId, 'SELECT ssn FROM raw_pii', 'blocked');
  await log(connId, 'SELECT * FROM does_not_exist', 'error');
  // A different connection's traffic must not leak in.
  await log(otherConnId, 'SELECT * FROM someone_elses_table', 'ok');
});

afterAll(async () => {
  await db.delete(connections).where(eq(connections.id, connId));
  await db.delete(connections).where(eq(connections.id, otherConnId));
});

describe('mineQueryRuns', () => {
  it('counts one shape per query pattern, not one per literal', async () => {
    const res = await mineQueryRuns(connId, 'sqlite');
    const orders = res.mined.find((m) => m.tables.includes('orders'));
    expect(orders).toBeDefined();
    expect(orders!.rawCount).toBe(3);
    expect(orders!.normalizedSql).not.toContain('2026-01-01');
  });

  it('reads only successful runs', async () => {
    // A mart designed around blocked or failing queries would institutionalize
    // the mistake rather than serve the question someone actually got answered.
    const res = await mineQueryRuns(connId, 'sqlite');
    expect(res.runsRead).toBe(4);
    const allTables = res.mined.flatMap((m) => m.tables);
    expect(allTables).not.toContain('raw_pii');
    expect(allTables).not.toContain('does_not_exist');
  });

  it('never reads another connection\'s history', async () => {
    const res = await mineQueryRuns(connId, 'sqlite');
    expect(res.mined.flatMap((m) => m.tables)).not.toContain('someone_elses_table');
  });

  it('respects the row limit', async () => {
    const res = await mineQueryRuns(connId, 'sqlite', 2);
    expect(res.runsRead).toBe(2);
  });

  it('returns empty rather than throwing on a connection with no history', async () => {
    // The common case for a brand-new connection, and the one the advisor must
    // degrade through instead of failing.
    const fresh = await newConnection('mining-reader-test-empty');
    try {
      const res = await mineQueryRuns(fresh, 'sqlite');
      expect(res.runsRead).toBe(0);
      expect(res.mined).toEqual([]);
    } finally {
      await db.delete(connections).where(eq(connections.id, fresh));
    }
  });
});
