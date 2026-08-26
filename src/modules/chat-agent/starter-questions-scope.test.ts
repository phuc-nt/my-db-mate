/**
 * Two prompt-building helpers that read the synced schema directly, so both had
 * to learn the same boundary the schema summary now honors: a starter question
 * is a one-click prompt, so it has to stay inside the
 * boundary the executor enforces. Suggesting an out-of-scope table hands the
 * user a question that comes back blocked, which reads as the product being
 * broken rather than the connection being governed.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '@/core/db/client';
import { connections, schemaTables, schemaColumns } from '@/core/db/schema';
import { verifiedQueries } from '@/core/db/context-schema';
import { getStarterQuestions } from '@/modules/chat-agent/starter-questions-service';
import { getBigTables } from '@/modules/chat-agent/agent-service';
import { setScope, type SchemaScope } from '@/core/boundary/schema-scope-service';

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

/** `events` is deliberately the largest, so an unfiltered heuristic picks it
 *  first, and sits above the default BIG_TABLE_ROWS threshold so the big-table
 *  prompt would name it too. */
async function seed(connectionId: string) {
  for (const [tableName, rowCount] of [['events', 2_400_000], ['orders', 1_000]] as const) {
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
/** Two datasets holding a same-named table, the withheld one synced first. */
let twinId: string;
/** Curated questions written before the scope was narrowed around them. */
let curatedId: string;

beforeAll(async () => {
  scopedId = await makeConnection('starter-scope-scoped', { tables: ['orders'] });
  await seed(scopedId);
  unscopedId = await makeConnection('starter-scope-unscoped', null);
  await seed(unscopedId);
  // `events` is inside this scope on purpose: the allowlist would let it
  // through, so only the viewsOnly rule can be what withholds it. Otherwise the
  // test passes even when the viewsOnly branch is deleted.
  viewsOnlyId = await makeConnection('starter-scope-views-only', { tables: ['orders', 'events'], viewsOnly: true });
  await seed(viewsOnlyId);

  // `raw.events` is withheld and `mart.events` is granted. The withheld twin is
  // inserted first so a lookup by bare name lands on it, which is what made the
  // in-scope suggestion disappear depending on physical row order.
  twinId = await makeConnection('starter-scope-twin', { tables: ['mart.events'] });
  for (const schemaName of ['raw', 'mart']) {
    const [t] = await db
      .insert(schemaTables)
      .values({ connectionId: twinId, tableName: 'events', schemaName, catalogName: null, rowCount: 2_400_000 })
      .returning({ id: schemaTables.id });
    await db.insert(schemaColumns).values([
      { tableId: t.id, columnName: 'created_at', dataType: 'timestamp', isPrimaryKey: false, ordinalPosition: 1 },
    ]);
  }

  curatedId = await makeConnection('starter-scope-curated', { tables: ['orders'] });
  await seed(curatedId);
  await db.insert(verifiedQueries).values([
    { connectionId: curatedId, question: 'How many orders last month?', sql: 'SELECT count(*) FROM orders' },
    { connectionId: curatedId, question: 'How many events last month?', sql: 'SELECT count(*) FROM events' },
  ]);
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

  it('drops a curated question whose query reaches outside the scope', async () => {
    const qs = (await getStarterQuestions(curatedId)).join('\n');
    expect(qs).toContain('How many orders last month?');
    expect(qs).not.toContain('How many events last month?');
  });

  it('still offers the in-scope table when a withheld dataset holds the same name', async () => {
    expect((await getStarterQuestions(twinId)).join('\n')).toContain('counts over time by created_at');
  });
});

// `getBigTables` feeds table names AND row counts straight into the system
// prompt. Unfiltered, the agent could cite the size of a table the connection
// withholds — which is how the leak was spotted, in a real chat answer.
describe('getBigTables', () => {
  it('omits a big table the scope withholds', async () => {
    const names = (await getBigTables(scopedId)).map((t) => t.name);
    expect(names).not.toContain('events');
  });

  it('states no big-table policy under viewsOnly, where no raw table is readable', async () => {
    expect(await getBigTables(viewsOnlyId)).toEqual([]);
  });

  it('still reports big tables on an unscoped connection', async () => {
    expect((await getBigTables(unscopedId)).map((t) => t.name)).toContain('events');
  });
});
