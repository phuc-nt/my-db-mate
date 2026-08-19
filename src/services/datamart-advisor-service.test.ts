/**
 * What the advisor knows before it asks the model anything.
 *
 * The model call is the visible part of this feature but not the risky part: a
 * proposal is only as good as the evidence handed to it, and a WRONG join edge
 * becomes a wrong grain in a mart the owner may hand to their data team as DDL.
 * So the assertions here are about evidence quality — that a declared foreign
 * key outranks a guess made off a column name, that generic columns produce no
 * edge at all, and that a missing input degrades loudly instead of passing a
 * partial survey off as a complete one.
 *
 * `collectAdvisorInputs` reads only the app's own database, so this exercises
 * the real function against a real Postgres fixture with nothing mocked. The
 * model call (`proposeDatamarts`) and the warehouse dry run (`validateProposal`)
 * are covered by real-connection UAT instead — mocking them here would assert
 * only that the mocks were wired up.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import Database from 'better-sqlite3';
import { db } from '../db/client';
import { connections, schemaTables, schemaColumns, schemaForeignKeys, queryRuns } from '../db/schema';
import { manualRelationships } from '../db/context-schema';
import { collectAdvisorInputs, adoptAsVirtualViews, type ValidatedProposal } from './datamart-advisor-service';
import { listViews, deleteView } from './virtual-view-service';

let connId: string;

/** `createView` probes the real database for the view's column list, so the
 *  connection must point at a database that actually has these tables. Tiny and
 *  built here rather than shared with another suite: the advisor's fixture is
 *  about join-key shapes, and coupling it to someone else's table names would
 *  make both suites fragile. */
const DB_PATH = resolve(process.cwd(), '.testdata/datamart-advisor.sqlite');

/** One table plus its columns, in the shape a real schema sync produces. */
async function seedTable(
  connectionId: string,
  tableName: string,
  rowCount: number,
  cols: [name: string, type: string, isPk: boolean][],
) {
  const [t] = await db.insert(schemaTables)
    .values({ connectionId, tableName, schemaName: null, rowCount })
    .returning({ id: schemaTables.id });
  await db.insert(schemaColumns).values(
    cols.map(([columnName, dataType, isPrimaryKey], i) => ({
      tableId: t.id, columnName, dataType, isPrimaryKey, isNullable: !isPrimaryKey, ordinalPosition: i + 1,
    })),
  );
  return t.id;
}

beforeAll(async () => {
  mkdirSync(resolve(process.cwd(), '.testdata'), { recursive: true });
  rmSync(DB_PATH, { force: true });
  const sqlite = new Database(DB_PATH);
  sqlite.exec(`
    CREATE TABLE customers (id INTEGER PRIMARY KEY, segment TEXT, name TEXT);
    CREATE TABLE products (id INTEGER PRIMARY KEY, name TEXT);
    CREATE TABLE orders (id INTEGER PRIMARY KEY, customer_id INTEGER, product_id INTEGER, revenue REAL, created_at TEXT);
    INSERT INTO customers (id, segment, name) VALUES (1, 'enterprise', 'Acme'), (2, 'smb', 'Bolt');
    INSERT INTO products (id, name) VALUES (1, 'Widget'), (2, 'Gadget');
    INSERT INTO orders (id, customer_id, product_id, revenue, created_at) VALUES
      (1, 1, 1, 100.0, '2026-02-01'), (2, 2, 2, 40.0, '2026-02-02'), (3, 1, 2, 60.0, '2026-02-03');
  `);
  sqlite.close();

  const [c] = await db.insert(connections).values({
    name: 'datamart-advisor-test', kind: 'sqlite-file', dialect: 'sqlite',
    config: { path: DB_PATH }, secretEncrypted: null, isReadOnlyVerified: true,
  }).returning({ id: connections.id });
  connId = c.id;

  await seedTable(connId, 'orders', 5000, [
    ['id', 'INTEGER', true],
    ['customer_id', 'INTEGER', false],
    ['product_id', 'INTEGER', false],
    ['revenue', 'REAL', false],
    ['created_at', 'TEXT', false],
  ]);
  await seedTable(connId, 'customers', 800, [
    ['id', 'INTEGER', true],
    ['segment', 'TEXT', false],
    ['name', 'TEXT', false],
  ]);
  await seedTable(connId, 'products', 300, [
    ['id', 'INTEGER', true],
    ['name', 'TEXT', false],
  ]);

  // A declared constraint for orders→customers. The name heuristic would also
  // find this edge, which is exactly why it is the interesting dedup case.
  await db.insert(schemaForeignKeys).values({
    connectionId: connId, fromTable: 'orders', fromColumn: 'customer_id', toTable: 'customers', toColumn: 'id',
  });
});

afterAll(async () => {
  await db.delete(connections).where(eq(connections.id, connId));
  rmSync(DB_PATH, { force: true });
});

const edge = (edges: { fromTable: string; fromColumn: string; toTable: string; toColumn: string; confidence: string }[],
  a: string, b: string) =>
  edges.find((e) => `${e.fromTable}.${e.fromColumn}~${e.toTable}.${e.toColumn}` === `${a}~${b}`
    || `${e.toTable}.${e.toColumn}~${e.fromTable}.${e.fromColumn}` === `${a}~${b}`);

describe('collectAdvisorInputs — join-key evidence', () => {
  it('keeps the declared foreign key rather than the name guess for the same edge', async () => {
    // Both sources see orders.customer_id = customers.id. Recording it as
    // `name_and_type` would tell the owner to double-check a join the warehouse
    // itself declares, and would make the model hedge in `assumptions`.
    const inputs = await collectAdvisorInputs(connId);
    const e = edge(inputs.joinEdges, 'orders.customer_id', 'customers.id');
    expect(e).toBeDefined();
    expect(e!.confidence).toBe('foreign_key');
  });

  it('infers <stem>_id to the table the stem names when nothing declares it', async () => {
    // orders.product_id → products.id has no constraint behind it, so the
    // advisor must find it by shape — this is the edge a same-name rule cannot
    // see, because the two columns are called different things.
    const inputs = await collectAdvisorInputs(connId);
    const e = edge(inputs.joinEdges, 'orders.product_id', 'products.id');
    expect(e).toBeDefined();
    expect(e!.confidence).toBe('name_and_type');
  });

  it('does not join two tables on generic column names', async () => {
    // customers.id and products.id are both `id` of type INTEGER, and both
    // `name` are TEXT. Every table has these; matching on them would connect
    // everything to everything and produce a meaningless grain.
    const inputs = await collectAdvisorInputs(connId);
    expect(edge(inputs.joinEdges, 'customers.id', 'products.id')).toBeUndefined();
    expect(edge(inputs.joinEdges, 'customers.name', 'products.name')).toBeUndefined();
  });

  it('promotes a manual relationship above a name guess', async () => {
    // A human note is weaker than a constraint but stronger than a heuristic:
    // someone looked at the data and said so.
    await db.insert(manualRelationships).values({
      connectionId: connId, fromTable: 'orders', fromColumn: 'product_id',
      toTable: 'products', toColumn: 'id', note: 'confirmed by the analytics team',
    });
    try {
      const inputs = await collectAdvisorInputs(connId);
      expect(edge(inputs.joinEdges, 'orders.product_id', 'products.id')!.confidence).toBe('manual');
    } finally {
      await db.delete(manualRelationships).where(eq(manualRelationships.connectionId, connId));
    }
  });
});

describe('collectAdvisorInputs — degradation is reported, never hidden', () => {
  it('says so when there is no usage history', async () => {
    const inputs = await collectAdvisorInputs(connId);
    expect(inputs.runsRead).toBe(0);
    expect(inputs.degraded).toBe(true);
    expect(inputs.degradedReasons.join(' ')).toMatch(/no usage history/i);
  });

  it('carries real usage through once the audit log has some', async () => {
    await db.insert(queryRuns).values({
      connectionId: connId, status: 'ok',
      sql: "SELECT c.segment, SUM(o.revenue) FROM orders o JOIN customers c ON o.customer_id = c.id WHERE o.created_at > '2026-01-01' GROUP BY c.segment",
    });
    try {
      const inputs = await collectAdvisorInputs(connId);
      expect(inputs.runsRead).toBe(1);
      expect(inputs.usage.length).toBe(1);
      expect(inputs.usage[0].tables).toEqual(expect.arrayContaining(['orders', 'customers']));
      expect(inputs.degradedReasons.join(' ')).not.toMatch(/no usage history/i);
    } finally {
      await db.delete(queryRuns).where(eq(queryRuns.connectionId, connId));
    }
  });

  it('degrades rather than throwing on a connection with no synced schema', async () => {
    // The advisor exists for warehouses nobody has planned. Refusing to run on
    // an empty one would fail exactly the user it is for.
    const [c] = await db.insert(connections).values({
      name: 'datamart-advisor-test-empty', kind: 'sqlite-file', dialect: 'sqlite',
      config: { path: '/nonexistent.sqlite' }, secretEncrypted: null, isReadOnlyVerified: true,
    }).returning({ id: connections.id });
    try {
      const inputs = await collectAdvisorInputs(c.id);
      expect(inputs.tables).toEqual([]);
      expect(inputs.degraded).toBe(true);
      expect(inputs.degradedReasons.join(' ')).toMatch(/no synced schema/i);
    } finally {
      await db.delete(connections).where(eq(connections.id, c.id));
    }
  });
});

describe('adoptAsVirtualViews', () => {
  /** A proposal shaped as validation would have left it: one good, one rejected. */
  const proposal = (): ValidatedProposal => ({
    marts: [{
      name: 'mart_sales',
      purpose: 'revenue by segment',
      grain: 'one row per customer segment',
      sourceTables: ['orders', 'customers'],
      assumptions: [],
      summaryTables: [
        {
          name: 'by_segment', description: 'revenue per segment', valid: true,
          sql: 'SELECT c.segment AS segment, SUM(o.revenue) AS revenue FROM orders o JOIN customers c ON o.customer_id = c.id GROUP BY c.segment',
        },
        {
          name: 'broken', description: 'never validated', valid: false,
          reason: 'Table not found: orders_typo', sql: 'SELECT * FROM orders_typo',
        },
      ],
    }],
    totalEstimatedBytes: 0,
  });

  it('adopts the valid statement and reports the invalid one without aborting', async () => {
    // Partial adoption is the point: being told which one of five did not take
    // is more useful than an all-or-nothing refusal on a long proposal.
    const res = await adoptAsVirtualViews(connId, proposal(), [
      { martName: 'mart_sales', summaryTableName: 'by_segment' },
      { martName: 'mart_sales', summaryTableName: 'broken' },
    ]);

    expect(res.adopted.map((a) => a.viewName)).toEqual(['mart_sales__by_segment']);
    expect(res.failed.length).toBe(1);
    expect(res.failed[0].viewName).toBe('mart_sales__broken');
    expect(res.failed[0].reason).toMatch(/orders_typo/);

    const views = await listViews(connId);
    const adopted = views.find((v) => v.name === 'mart_sales__by_segment');
    expect(adopted).toBeDefined();
    // The grain travels with the view, so whoever reads a number from it later
    // can see what one row was meant to mean.
    expect(adopted!.description).toMatch(/one row per customer segment/);
    await deleteView(connId, adopted!.id);
  });

  it('adopts nothing that was not selected', async () => {
    const res = await adoptAsVirtualViews(connId, proposal(), []);
    expect(res.adopted).toEqual([]);
    expect(res.failed).toEqual([]);
  });
});
