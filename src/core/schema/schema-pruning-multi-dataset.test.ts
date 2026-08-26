/**
 * Multi-dataset key-collision regression (hygiene item 5): a BigQuery connection
 * with the SAME table name in two datasets must present BOTH tables (each with
 * its own columns and dataset qualification) — the bare-name Map silently kept
 * only the last one. Also guards the "silently empty summary" failure mode a key
 * change could introduce: bare-name inputs must still resolve.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '@/core/db/client';
import { connections, schemaTables, schemaColumns } from '@/core/db/schema';
import { getPrunedSchemaSummary } from '@/core/schema/schema-pruning-service';

let connId: string;

beforeAll(async () => {
  const [c] = await db.insert(connections).values({
    name: 'pruning-multi-dataset-test', kind: 'bigquery-driver', dialect: 'bigquery',
    config: { projectId: 'test' }, secretEncrypted: null, isReadOnlyVerified: true,
  }).returning({ id: connections.id });
  connId = c.id;
  // Same table name `events` in two datasets, different columns.
  const [t1] = await db.insert(schemaTables).values({ connectionId: connId, tableName: 'events', schemaName: 'sales', rowCount: 10 }).returning({ id: schemaTables.id });
  const [t2] = await db.insert(schemaTables).values({ connectionId: connId, tableName: 'events', schemaName: 'marketing', rowCount: 10 }).returning({ id: schemaTables.id });
  await db.insert(schemaColumns).values([
    { tableId: t1.id, columnName: 'order_id', dataType: 'INT64', isPrimaryKey: true, ordinalPosition: 1 },
    { tableId: t2.id, columnName: 'campaign_id', dataType: 'STRING', isPrimaryKey: false, ordinalPosition: 1 },
  ]);
});

afterAll(async () => {
  await db.delete(connections).where(eq(connections.id, connId));
});

describe('schema pruning — multi-dataset same-name tables (BQ)', () => {
  it('presents BOTH datasets’ tables with their own columns + qualification', async () => {
    const summary = await getPrunedSchemaSummary(connId, 'events overview');
    expect(summary).toContain('sales.events(order_id INT64 PK)');
    expect(summary).toContain('marketing.events(campaign_id STRING)');
  });

  it('summary is never silently empty for this connection (key-scheme regression guard)', async () => {
    const summary = await getPrunedSchemaSummary(connId, 'anything at all');
    expect(summary.length).toBeGreaterThan(0);
    // exactly the two tables, deduped
    expect(summary.split('\n')).toHaveLength(2);
  });
});
