/**
 * A saved definition must take effect on the very next query.
 *
 * Expansion reads a process-local cache, so every write path has to drop it.
 * That invalidation lives inside the service rather than in the API routes: a
 * route that forgot would keep serving the OLD definition, meaning the number
 * silently stops matching the meaning everyone agreed on — the exact failure
 * this whole layer exists to prevent. These tests exercise the service functions
 * directly, so they fail if the invalidation is ever moved back out to callers.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { resolve } from 'node:path';
import { db } from '../db/client';
import { connections, schemaColumns, schemaTables } from '../db/schema';
import { createView, deleteView, expandForConnection, previewDefinition, updateView } from './virtual-view-service';
import { setScope } from './schema-scope-service';

const DB_PATH = resolve(process.cwd(), '.testdata/scope-governance.sqlite');

let connId = '';

async function newConnection(): Promise<string> {
  const [c] = await db.insert(connections).values({
    name: 'view-cache-test', kind: 'sqlite-file', dialect: 'sqlite',
    config: { path: DB_PATH }, secretEncrypted: null, isReadOnlyVerified: true,
  }).returning({ id: connections.id });
  connId = c.id;

  // The scope guard requires every reference to resolve against the SYNCED
  // schema, so a connection with no synced tables admits nothing. Mirror the
  // fixture's real tables here, exactly as a sync would.
  for (const [name, cols] of [
    ['mart_orders', ['order_id', 'order_date', 'region', 'status', 'revenue']],
    ['mart_customers', ['customer_id', 'segment', 'signup_date']],
    ['raw_pii', ['id', 'email', 'ssn', 'salary']],
  ] as const) {
    const [t] = await db.insert(schemaTables)
      .values({ connectionId: c.id, tableName: name, schemaName: null, rowCount: 100 })
      .returning({ id: schemaTables.id });
    await db.insert(schemaColumns).values(
      cols.map((columnName, i) => ({
        tableId: t.id, columnName, dataType: 'TEXT', isPrimaryKey: i === 0, ordinalPosition: i + 1,
      })),
    );
  }
  return c.id;
}

afterEach(async () => {
  if (connId) await db.delete(connections).where(eq(connections.id, connId));
  connId = '';
});

const expand = (id: string, sql: string) => expandForConnection(id, sql, 'sqlite', false);

describe('a definition change is visible to the next query', () => {
  it('creating a view makes it expandable immediately', async () => {
    const id = await newConnection();

    // Warm the cache on the empty state first — without invalidation this is
    // exactly the read that would keep the new view invisible.
    const before = await expand(id, 'SELECT * FROM paid_orders');
    expect(before.status).toBe('unchanged');

    await createView({
      connectionId: id, name: 'paid_orders',
      sql: "SELECT * FROM mart_orders WHERE status='P'",
    });

    const after = await expand(id, 'SELECT * FROM paid_orders');
    expect(after.status).toBe('expanded');
    expect(after.status !== 'blocked' && after.sql).toContain("status='P'");
  });

  it('editing the SQL replaces the old definition rather than reusing it', async () => {
    const id = await newConnection();
    const view = await createView({
      connectionId: id, name: 'regional', sql: "SELECT region FROM mart_orders WHERE status='P'",
    });
    const first = await expand(id, 'SELECT * FROM regional');
    expect(first.status !== 'blocked' && first.sql).toContain("status='P'");

    await updateView({
      connectionId: id, id: view.id, sql: "SELECT region FROM mart_orders WHERE status='A'",
    });

    const second = await expand(id, 'SELECT * FROM regional');
    expect(second.status !== 'blocked' && second.sql).toContain("status='A'");
    expect(second.status !== 'blocked' && second.sql).not.toContain("status='P'");
  });

  it('deleting a view stops it from expanding', async () => {
    const id = await newConnection();
    const view = await createView({
      connectionId: id, name: 'doomed', sql: 'SELECT region FROM mart_orders',
    });
    expect((await expand(id, 'SELECT * FROM doomed')).status).toBe('expanded');

    await deleteView(id, view.id);

    // No longer a known view, so the reference passes through untouched — and
    // then fails as an unknown table, which is the honest outcome.
    expect((await expand(id, 'SELECT * FROM doomed')).status).toBe('unchanged');
  });

  it('disabling a view retires it without losing the definition', async () => {
    const id = await newConnection();
    const view = await createView({
      connectionId: id, name: 'retired', sql: 'SELECT region FROM mart_orders',
    });
    await updateView({ connectionId: id, id: view.id, isDisabled: true });
    expect((await expand(id, 'SELECT * FROM retired')).status).toBe('unchanged');

    await updateView({ connectionId: id, id: view.id, isDisabled: false });
    expect((await expand(id, 'SELECT * FROM retired')).status).toBe('expanded');
  });
});

/**
 * Authoring must keep working after `viewsOnly` is switched on.
 *
 * A view definition reads raw tables by construction — that is what makes it a
 * definition. Judging a candidate under `viewsOnly` would therefore mean that
 * enabling the mode froze the view set permanently: no new definition could be
 * previewed, so none could be authored with any confidence. The governed
 * boundary that still applies is the table scope, and it does apply.
 */
describe('previewing a candidate definition', () => {
  it('reads a raw table the table-scope grants, even under viewsOnly', async () => {
    const id = await newConnection();
    await setScope(id, { tables: ['mart_orders', 'mart_customers'], viewsOnly: true });

    const out = await previewDefinition({
      connectionId: id,
      sql: 'SELECT region, COUNT(*) AS n FROM mart_orders GROUP BY region',
    });
    expect(out.columns).toEqual(['region', 'n']);
    expect(out.rows.length).toBe(4);
  });

  it('still refuses SQL the table scope forbids', async () => {
    const id = await newConnection();
    await setScope(id, { tables: ['mart_orders'], viewsOnly: true });
    await expect(previewDefinition({ connectionId: id, sql: 'SELECT ssn FROM raw_pii' }))
      .rejects.toThrow(/governed scope/i);
  });

  it('still refuses a write statement', async () => {
    const id = await newConnection();
    await expect(previewDefinition({ connectionId: id, sql: 'DELETE FROM mart_orders' }))
      .rejects.toThrow(/safety layer/i);
  });
});
