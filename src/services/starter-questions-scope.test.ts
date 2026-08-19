/**
 * A starter question is a one-click prompt, so it has to stay inside the
 * boundary the executor enforces. Suggesting an out-of-scope table hands the
 * user a question that comes back blocked, which reads as the product being
 * broken rather than the connection being governed.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '../db/client';
import { connections, schemaTables, schemaColumns } from '../db/schema';
import { getStarterQuestions } from './starter-questions-service';
import { setScope, type SchemaScope } from './schema-scope-service';

const created: string[] = [];

async function makeConnection(name: string, scope: SchemaScope | null) {
  const [c] = await db
    .insert(connections)
    .values({ name, kind: 'tcp-driver', dialect: 'postgres', config: {}, secretEncrypted: null, isReadOnlyVerified: true })
    .returning({ id: connections.id });
  created.push(c.id);
  if (scope) await setScope(c.id, scope);
  return c.id;
}

/** `events` is deliberately the largest, so an unfiltered heuristic picks it first. */
async function seed(connectionId: string) {
  for (const [tableName, rowCount] of [['events', 900_000], ['orders', 1_000]] as const) {
    const [t] = await db
      .insert(schemaTables)
      .values({ connectionId, tableName, schemaName: 'public', catalogName: null, rowCount })
      .returning({ id: schemaTables.id });
    await db.insert(schemaColumns).values([
      { tableId: t.id, columnName: 'created_at', dataType: 'timestamp', isPrimaryKey: false, ordinalPosition: 1 },
    ]);
  }
}

let scopedId: string;
let unscopedId: string;
let viewsOnlyId: string;

beforeAll(async () => {
  scopedId = await makeConnection('starter-scope-scoped', { tables: ['orders'] });
  await seed(scopedId);
  unscopedId = await makeConnection('starter-scope-unscoped', null);
  await seed(unscopedId);
  viewsOnlyId = await makeConnection('starter-scope-views-only', { tables: ['orders'], viewsOnly: true });
  await seed(viewsOnlyId);
});

afterAll(async () => {
  for (const id of created) await db.delete(connections).where(eq(connections.id, id));
});

describe('getStarterQuestions', () => {
  it('never suggests a table the scope withholds, even the largest one', async () => {
    const qs = await getStarterQuestions(scopedId);
    expect(qs.join('\n')).not.toContain('events');
    expect(qs.join('\n')).toContain('orders');
  });

  it('offers nothing raw under viewsOnly, where no table is readable', async () => {
    expect(await getStarterQuestions(viewsOnlyId)).toEqual([]);
  });

  it('still picks the largest table on an unscoped connection', async () => {
    expect((await getStarterQuestions(unscopedId)).join('\n')).toContain('events');
  });
});
