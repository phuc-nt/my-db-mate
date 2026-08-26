/**
 * Throwaway connections for the benchmark's 11 SQLite databases.
 *
 * Bench runs against the SAME app DB the user's real connections live in —
 * there is no separate benchmark database, and creating one would mean the
 * benchmark no longer exercises the code path the product uses. So every row
 * this file writes is tagged with a name prefix, and cleanup deletes by that
 * prefix only. A run must never be able to remove a connection a human made.
 *
 * The prefix alone is not enough: it identifies rows as SOME bench run's, not
 * as THIS run's. A cleanup scoped to the bare prefix deletes connections a
 * concurrently running benchmark is still using, and because
 * `glossary_terms.connection_id` is a foreign key, that run's next evidence
 * insert dies with PG 23503 mid-flight. The run id in the name is what makes
 * cleanup scoped to its own rows.
 */
import { eq, like } from 'drizzle-orm';
import { db } from '@/core/db/client';
import { connections } from '@/core/db/schema';
import { createConnection } from '@/core/connections/connection-service';
import { syncSchema } from '@/core/schema/schema-sync-service';

/** Name prefix that marks a connection as this harness's to delete. Anything
 *  without it is someone else's, whatever it looks like. */
export const BENCH_PREFIX = 'bench:';

/** `bench:<runId>:<dbId>`. The run id is in the NAME because that is the only
 *  field cleanup can filter on without a schema change, and it is what keeps
 *  one run's cleanup off another run's rows. */
function benchName(runId: string, dbId: string): string {
  return `${BENCH_PREFIX}${runId}:${dbId}`;
}

/**
 * Get (or create) the connection for one BIRD database, schema already synced.
 *
 * Reused across the ~50 questions that share a database: creating and
 * introspecting per question would dominate the runtime and measure our
 * introspection speed rather than the agent's accuracy.
 */
export async function ensureBenchConnection(runId: string, dbId: string, dbPath: string): Promise<string> {
  const name = benchName(runId, dbId);
  const [existing] = await db.select({ id: connections.id, config: connections.config })
    .from(connections).where(eq(connections.name, name)).limit(1);

  if (existing) {
    // A stale row pointing at a path from an earlier download would answer every
    // question against the wrong file, so the path is checked rather than assumed.
    if (String(existing.config.path) === dbPath) return existing.id;
    await db.delete(connections).where(eq(connections.id, existing.id));
  }

  const row = await createConnection({
    name, kind: 'sqlite-file', dialect: 'sqlite', config: { path: dbPath },
  });
  await syncSchema(row.id);
  return row.id;
}

/**
 * Delete the connections THIS run created.
 *
 * Scoped two ways, and both matter: the prefix keeps a connection a human made
 * out of range even if it names a BIRD database, and the run id keeps a
 * concurrent benchmark's connections out of range even though they share the
 * prefix. Deleting by the bare prefix is what broke a determinism run.
 */
export async function cleanupBenchConnections(runId: string): Promise<number> {
  const rows = await db.delete(connections)
    .where(like(connections.name, `${BENCH_PREFIX}${runId}:%`))
    .returning({ id: connections.id });
  return rows.length;
}
