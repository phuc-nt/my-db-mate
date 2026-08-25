/**
 * Both schema renderers describe the same boundary.
 *
 * `getPrunedSchemaSummary` filtered to the governed scope; `getSchemaSummary`
 * did not — so the same connection described itself differently depending on
 * which caller reached it, and the callers of the unfiltered one (the MCP
 * `get_schema_context` tool, the agent's own `schema_details` tool, investigate
 * decompose, follow-up suggestions) handed out names and columns of tables the
 * connection does not grant. Every case below runs through BOTH renderers, so a
 * future divergence fails here rather than leaking quietly.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '@/core/db/client';
import { connections, schemaTables, schemaColumns, schemaForeignKeys } from '@/core/db/schema';
import { virtualViews } from '@/core/db/context-schema';
import { getSchemaSummary } from './schema-sync-service';
import { getPrunedSchemaSummary } from './schema-pruning-service';
import { setScope, type SchemaScope } from './schema-scope-service';

const created: string[] = [];

async function makeConnection(name: string, scope: SchemaScope | null) {
  const [c] = await db
    .insert(connections)
    .values({
      name,
      kind: 'tcp-driver',
      dialect: 'postgres',
      config: {},
      secretEncrypted: null,
      isReadOnlyVerified: true,
    })
    .returning({ id: connections.id });
  created.push(c.id);
  if (scope) await setScope(c.id, scope);
  return c.id;
}

async function addTable(connectionId: string, tableName: string, schemaName: string | null = 'public') {
  const [t] = await db
    .insert(schemaTables)
    .values({ connectionId, tableName, schemaName, catalogName: null, rowCount: 10 })
    .returning({ id: schemaTables.id });
  await db.insert(schemaColumns).values([
    { tableId: t.id, columnName: 'id', dataType: 'int', isPrimaryKey: true, ordinalPosition: 1 },
  ]);
}

async function addFk(connectionId: string, fromTable: string, toTable: string) {
  await db.insert(schemaForeignKeys).values({
    connectionId, fromTable, fromColumn: 'id', toTable, toColumn: 'id',
  });
}

async function addView(connectionId: string, name: string) {
  await db.insert(virtualViews).values({
    connectionId,
    name,
    description: 'curated revenue definition',
    sql: 'SELECT 1',
    columnsCache: [{ name: 'total', type: 'numeric' }],
  });
}

/** Scope of `orders`+`users`, with `secrets` synced but excluded. */
let scopedId: string;
/** No scope at all — the regression guard for the majority of connections. */
let unscopedId: string;
/** viewsOnly with a curated view present. */
let viewsOnlyId: string;
/** viewsOnly with nothing curated: the fail-closed case. */
let viewsOnlyEmptyId: string;
/** viewsOnly whose allowlist matches nothing synced, so no table resolves at all. */
let noResolveId: string;

beforeAll(async () => {
  scopedId = await makeConnection('scope-parity-scoped', { tables: ['orders', 'users'] });
  for (const t of ['orders', 'users', 'secrets']) await addTable(scopedId, t);
  await addFk(scopedId, 'orders', 'users');
  await addFk(scopedId, 'orders', 'secrets');

  unscopedId = await makeConnection('scope-parity-unscoped', null);
  for (const t of ['orders', 'users', 'secrets']) await addTable(unscopedId, t);
  await addFk(unscopedId, 'orders', 'secrets');

  // `orders` is inside this scope on purpose, so the allowlist cannot be what
  // hides it — only the viewsOnly rule can. A scope that excluded it would let
  // the test pass even with the viewsOnly branch deleted.
  viewsOnlyId = await makeConnection('scope-parity-views-only', { tables: ['orders'], viewsOnly: true });
  await addTable(viewsOnlyId, 'orders');
  await addView(viewsOnlyId, 'doanh_thu_thang');

  viewsOnlyEmptyId = await makeConnection('scope-parity-views-only-empty', { tables: ['orders'], viewsOnly: true });
  await addTable(viewsOnlyEmptyId, 'orders');

  // The allowlist names a table this connection never synced, so table
  // resolution comes back empty. The governed views still have to be described:
  // an empty table set is the normal case here, not a degenerate one.
  noResolveId = await makeConnection('scope-parity-no-resolve', { tables: ['nothing_matches'], viewsOnly: true });
  await addTable(noResolveId, 'orders');
  await addView(noResolveId, 'doanh_thu_thang');
});

afterAll(async () => {
  for (const id of created) await db.delete(connections).where(eq(connections.id, id));
});

describe.each([
  ['getSchemaSummary', (id: string) => getSchemaSummary(id)],
  ['getPrunedSchemaSummary', (id: string) => getPrunedSchemaSummary(id, 'orders users secrets overview')],
])('%s', (_label, render) => {
  it('lists in-scope tables and omits the ones the scope withholds', async () => {
    const summary = await render(scopedId);
    expect(summary).toContain('orders(');
    expect(summary).toContain('users(');
    expect(summary).not.toContain('secrets');
  });

  it('drops a foreign key pointing at a table outside the scope', async () => {
    const summary = await render(scopedId);
    expect(summary).not.toContain('-> secrets.id');
  });

  it('leaves an unscoped connection showing everything it synced', async () => {
    const summary = await render(unscopedId);
    for (const t of ['orders(', 'users(', 'secrets(']) expect(summary).toContain(t);
  });

  it('shows only the governed views under viewsOnly', async () => {
    const summary = await render(viewsOnlyId);
    expect(summary).toContain('doanh_thu_thang(total numeric)');
    expect(summary).not.toContain('orders(');
    expect(summary).not.toContain('FK:');
  });

  it('withholds raw tables under viewsOnly even when no view is defined yet', async () => {
    const summary = await render(viewsOnlyEmptyId);
    expect(summary).not.toContain('orders(');
    expect(summary).toMatch(/governed view/i);
  });

  it('still describes the governed views when no table resolves at all', async () => {
    const summary = await render(noResolveId);
    expect(summary).toContain('doanh_thu_thang(total numeric)');
    expect(summary).not.toContain('orders(');
  });
});

// Only `getSchemaSummary` renders foreign-key lines; the pruned renderer never
// has, and this phase did not add them there. The shared cases above assert the
// negative (an out-of-scope end never appears) for both.
describe('getSchemaSummary foreign keys', () => {
  it('keeps a foreign key whose two ends are both in scope', async () => {
    expect(await getSchemaSummary(scopedId)).toContain('FK: orders.id -> users.id');
  });

  it('still shows every foreign key on an unscoped connection', async () => {
    expect(await getSchemaSummary(unscopedId)).toContain('FK: orders.id -> secrets.id');
  });
});
