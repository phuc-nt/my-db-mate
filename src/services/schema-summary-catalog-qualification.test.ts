/**
 * What the model is shown for a BigQuery connection whose datasets live in
 * another project.
 *
 * A two-part `dataset.table` resolves against the connection's own project, so a
 * dataset shared in from elsewhere fails with "Dataset ... was not found" — the
 * name the model copies out of the schema listing has to carry the project. Both
 * renderers (full summary and pruned summary) are covered, since the agent uses
 * whichever one the caller reached for, and a connection with no catalogs
 * recorded must still render exactly as it did before.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '@/core/db/client';
import { connections, schemaTables, schemaColumns } from '@/core/db/schema';
import { getSchemaSummary } from './schema-sync-service';
import { getPrunedSchemaSummary } from './schema-pruning-service';

let crossProjectConnId: string;
let ownProjectConnId: string;
let postgresConnId: string;

async function makeConnection(name: string, dialect: 'bigquery' | 'postgres') {
  const [c] = await db
    .insert(connections)
    .values({
      name,
      kind: dialect === 'bigquery' ? 'bigquery-driver' : 'tcp-driver',
      dialect,
      config: { projectId: 'own-project' },
      secretEncrypted: null,
      isReadOnlyVerified: true,
    })
    .returning({ id: connections.id });
  return c.id;
}

async function addTable(
  connectionId: string,
  table: { tableName: string; schemaName: string | null; catalogName: string | null },
) {
  const [t] = await db
    .insert(schemaTables)
    .values({ connectionId, ...table, rowCount: 100 })
    .returning({ id: schemaTables.id });
  await db.insert(schemaColumns).values([
    { tableId: t.id, columnName: 'order_id', dataType: 'INT64', isPrimaryKey: true, ordinalPosition: 1 },
  ]);
}

beforeAll(async () => {
  crossProjectConnId = await makeConnection('catalog-qualification-cross-project', 'bigquery');
  await addTable(crossProjectConnId, {
    tableName: 'orders',
    schemaName: 'thelook_ecommerce',
    catalogName: 'bigquery-public-data',
  });

  ownProjectConnId = await makeConnection('catalog-qualification-own-project', 'bigquery');
  await addTable(ownProjectConnId, { tableName: 'orders', schemaName: 'sales', catalogName: null });

  postgresConnId = await makeConnection('catalog-qualification-postgres', 'postgres');
  await addTable(postgresConnId, { tableName: 'orders', schemaName: 'public', catalogName: 'ignored' });
});

afterAll(async () => {
  for (const id of [crossProjectConnId, ownProjectConnId, postgresConnId]) {
    await db.delete(connections).where(eq(connections.id, id));
  }
});

describe.each([
  ['getSchemaSummary', (id: string) => getSchemaSummary(id)],
  ['getPrunedSchemaSummary', (id: string) => getPrunedSchemaSummary(id, 'orders overview')],
])('%s', (_label, render) => {
  it('spells out the project for a dataset owned by another one', async () => {
    const summary = await render(crossProjectConnId);
    expect(summary).toContain('bigquery-public-data.thelook_ecommerce.orders(');
  });

  it('tells the model to copy the name verbatim, so it does not shorten it back', async () => {
    const summary = await render(crossProjectConnId);
    expect(summary).toMatch(/verbatim/i);
  });

  it('leaves a BigQuery connection with no catalogs recorded on the two-part name', async () => {
    const summary = await render(ownProjectConnId);
    expect(summary).toContain('sales.orders(');
    expect(summary).not.toMatch(/verbatim/i);
  });

  it('never qualifies a dialect that has no catalog level', async () => {
    const summary = await render(postgresConnId);
    expect(summary).toContain('orders(');
    expect(summary).not.toContain('ignored');
    expect(summary).not.toContain('public.orders');
  });
});
