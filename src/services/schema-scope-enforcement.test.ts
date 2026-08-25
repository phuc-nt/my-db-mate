/**
 * The governed boundary, enforced end-to-end against a real SQLite database.
 *
 * The extractor has its own unit tests; this file asks the harder question: does
 * the boundary actually hold at the choke point every caller goes through? Each
 * bypass shape below hides a reference where a naive top-level-FROM walk cannot
 * see it, and every one of them must come back `blocked` with no rows attached.
 * A test asserting only on the extractor would pass even if the guard were never
 * wired in, which is exactly the regression worth catching.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { resolve } from 'node:path';
import { db } from '@/core/db/client';
import { connections, schemaTables, schemaColumns } from '@/core/db/schema';
import { executeQuery } from './query-executor-service';
import { setScope } from './schema-scope-service';

const DB_PATH = resolve(process.cwd(), '.testdata/scope-governance.sqlite');

let connId: string;

/** The scope granted in these tests: the two curated marts, nothing raw. */
const MART_SCOPE = { tables: ['mart_orders', 'mart_customers'] };

const run = (sql: string) => executeQuery({ connectionId: connId, sql, confirmed: true });

beforeAll(async () => {
  const [c] = await db.insert(connections).values({
    name: 'scope-enforcement-test', kind: 'sqlite-file', dialect: 'sqlite',
    config: { path: DB_PATH }, secretEncrypted: null, isReadOnlyVerified: true,
  }).returning({ id: connections.id });
  connId = c.id;

  // Mirror the four real tables into the synced schema so the block message can
  // list what IS in scope (and so pruning has something to filter).
  for (const [name, cols] of [
    ['mart_orders', ['order_id', 'order_date', 'region', 'status', 'revenue']],
    ['mart_customers', ['customer_id', 'segment', 'signup_date']],
    ['raw_pii', ['id', 'email', 'ssn', 'salary']],
    ['raw_events', ['id', 'ts', 'kind']],
  ] as const) {
    const [t] = await db.insert(schemaTables)
      .values({ connectionId: connId, tableName: name, schemaName: null, rowCount: 100 })
      .returning({ id: schemaTables.id });
    await db.insert(schemaColumns).values(
      cols.map((columnName, i) => ({
        tableId: t.id, columnName, dataType: 'TEXT', isPrimaryKey: i === 0, ordinalPosition: i + 1,
      })),
    );
  }
});

afterAll(async () => {
  await db.delete(connections).where(eq(connections.id, connId));
});

describe('unscoped connection (the default) is unchanged', () => {
  it('reads any table, including ones a scope would later withhold', async () => {
    await setScope(connId, null);
    const res = await run('SELECT COUNT(*) FROM raw_pii');
    expect(res.status).toBe('ok');
    expect(Number(res.result!.rows[0][0])).toBe(100);
  });
});

describe('scoped connection — in-bounds queries still work', () => {
  beforeAll(async () => { await setScope(connId, MART_SCOPE); });

  it('runs a query over a granted table and returns real rows', async () => {
    const res = await run('SELECT region, COUNT(*) AS n FROM mart_orders GROUP BY region ORDER BY region');
    expect(res.status).toBe('ok');
    expect(res.result!.rows.length).toBe(4);
    // 500 orders spread across 4 regions by the fixture builder.
    const total = res.result!.rows.reduce((s, r) => s + Number(r[1]), 0);
    expect(total).toBe(500);
  });

  it('joins two granted tables', async () => {
    const res = await run('SELECT COUNT(*) FROM mart_orders o JOIN mart_customers c ON o.order_id = c.customer_id');
    expect(res.status).toBe('ok');
    expect(Number(res.result!.rows[0][0])).toBe(200);
  });

  it('allows a statement that reads no table at all', async () => {
    const res = await run('SELECT 1');
    expect(res.status).toBe('ok');
  });
});

describe('scoped connection — the four bypass shapes are all blocked', () => {
  beforeAll(async () => { await setScope(connId, MART_SCOPE); });

  const cases: [string, string][] = [
    ['direct FROM', 'SELECT email FROM raw_pii'],
    ['WHERE subquery', 'SELECT * FROM mart_orders WHERE order_id IN (SELECT id FROM raw_pii)'],
    ['CTE body', 'WITH leak AS (SELECT ssn FROM raw_pii) SELECT * FROM leak'],
    ['derived table', 'SELECT * FROM (SELECT salary FROM raw_pii) x'],
    ['UNION branch', 'SELECT order_id FROM mart_orders UNION SELECT id FROM raw_pii'],
    ['scalar subquery', 'SELECT (SELECT MAX(salary) FROM raw_pii) AS m FROM mart_orders LIMIT 1'],
    ['CTE shadowing a granted name', 'WITH mart_orders AS (SELECT ssn FROM raw_pii) SELECT * FROM mart_orders'],
  ];

  it.each(cases)('blocks: %s', async (_label, sql) => {
    const res = await run(sql);
    expect(res.status).toBe('blocked');
    expect(res.blockedReason).toMatch(/raw_pii/);
    // Nothing leaks alongside the refusal.
    expect(res.result).toBeUndefined();
  });

  it('names the in-scope tables so the agent can retry without a round trip', async () => {
    const res = await run('SELECT * FROM raw_events');
    expect(res.status).toBe('blocked');
    expect(res.blockedReason).toContain('mart_orders');
    expect(res.blockedReason).toContain('mart_customers');
  });

  it('blocks SQL it cannot parse rather than letting it through', async () => {
    const res = await run('SELECT ?? FROM !!!');
    expect(res.status).toBe('blocked');
  });
});

/**
 * The parser's output is lossy, and each shape below is a way an attacker can
 * exploit that loss to make a forbidden table LOOK like a permitted one. They
 * are grouped apart from the bypass shapes above because they attack the
 * IDENTIFIER rather than the query structure: the extractor faithfully reports
 * a reference, just not the one that will actually be read. The defense is the
 * resolution requirement — a reference that names nothing in the synced schema
 * is refused rather than reasoned about.
 */
describe('scoped connection — identifier-level attacks are blocked', () => {
  beforeAll(async () => { await setScope(connId, MART_SCOPE); });

  it('does not let a quoted name containing a dot pose as schema.table', async () => {
    // `tableList` flattens to `type::schema::table` and forgets the quoting, so
    // a table literally named `mart_orders.raw_pii_leak` used to split into a
    // grant for `mart_orders` plus an arbitrary table under it. On non-BigQuery
    // dialects the split no longer happens at all, so the whole dotted string
    // stays one name — which matches nothing in scope.
    const res = await run('SELECT * FROM "mart_orders.raw_pii_leak"');
    expect(res.status).toBe('blocked');
    expect(res.result).toBeUndefined();
  });

  it('blocks a reference to a table the sync has never seen', async () => {
    // The distinguishing case for the resolution requirement: nothing about the
    // NAME is suspicious, it simply corresponds to no synced table, so the guard
    // has no way to place it inside or outside the boundary and refuses.
    const res = await run('SELECT * FROM mart_orders_shadow');
    expect(res.status).toBe('blocked');
    expect(res.blockedReason).toMatch(/synced schema/i);
  });

  it('blocks when the real table hides behind a parser quirk', async () => {
    // Postgres `FROM ONLY t` parses as table `ONLY` aliased `t`, so the
    // extractor reports `ONLY` — a name no sync ever produced. Blocked twice
    // over: `ONLY` is neither in scope nor in the synced schema.
    const res = await run('SELECT * FROM ONLY raw_pii');
    expect(res.status).toBe('blocked');
    expect(res.result).toBeUndefined();
  });

  it('treats a wildcard-only scope entry as naming nothing, not everything', async () => {
    await setScope(connId, { tables: ['*'] });
    const res = await run('SELECT email FROM raw_pii');
    expect(res.status).toBe('blocked');
    await setScope(connId, MART_SCOPE);
  });
});

describe('scope changes take effect immediately', () => {
  it('re-admits a table once the scope grants it', async () => {
    await setScope(connId, MART_SCOPE);
    expect((await run('SELECT COUNT(*) FROM raw_events')).status).toBe('blocked');

    await setScope(connId, { tables: ['mart_orders', 'mart_customers', 'raw_events'] });
    const res = await run('SELECT COUNT(*) FROM raw_events');
    expect(res.status).toBe('ok');
    expect(Number(res.result!.rows[0][0])).toBe(300);
  });

  it('an empty scope means unscoped, not locked out', async () => {
    await setScope(connId, { datasets: [], tables: [] });
    expect((await run('SELECT COUNT(*) FROM raw_pii')).status).toBe('ok');
  });
});
