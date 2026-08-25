/**
 * Cleanup scoping.
 *
 * `cleanupBenchConnections` deletes by the `bench:` NAME prefix, which matches
 * every bench connection on the machine rather than only the ones the calling
 * run created. Two benchmark runs sharing the app database — or a run
 * overlapping anything else that uses the prefix — therefore delete each
 * other's connections mid-flight, and `glossary_terms.connection_id` is a
 * foreign key, so the next evidence insert dies with PG 23503.
 *
 * That is not hypothetical: it killed a determinism run four questions in.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { eq, like } from 'drizzle-orm';
import { db } from '@/core/db/client';
import { connections } from '@/core/db/schema';
import { cleanupBenchConnections, BENCH_PREFIX } from './bench-connections';

const created: string[] = [];

async function makeRow(name: string): Promise<string> {
  const [row] = await db.insert(connections).values({
    name, kind: 'sqlite-file', dialect: 'sqlite', config: { path: ':memory:' },
  }).returning({ id: connections.id });
  created.push(row.id);
  return row.id;
}

afterAll(async () => {
  for (const id of created) await db.delete(connections).where(eq(connections.id, id));
});

describe('cleanupBenchConnections', () => {
  it('leaves connections belonging to a different run alone', async () => {
    const mine = await makeRow(`${BENCH_PREFIX}run-a:financial`);
    const theirs = await makeRow(`${BENCH_PREFIX}run-b:financial`);

    await cleanupBenchConnections('run-a');

    const survivors = await db.select({ id: connections.id })
      .from(connections).where(like(connections.name, `${BENCH_PREFIX}%`));
    const ids = survivors.map((r) => r.id);
    expect(ids).not.toContain(mine);
    expect(ids).toContain(theirs);
  });

  it('never deletes a connection a human made, whatever it is named', async () => {
    const human = await makeRow('financial (mine)');
    await cleanupBenchConnections('run-a');
    const [still] = await db.select({ id: connections.id })
      .from(connections).where(eq(connections.id, human));
    expect(still).toBeTruthy();
  });
});
