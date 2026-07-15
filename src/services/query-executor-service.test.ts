/**
 * Integration parity test (Phase 2, Implementation Step 7): accelerated and
 * non-accelerated runs of the identical SQL against the identical SQLite data
 * must return row-for-row identical results through `executeQuery()` itself —
 * not just the underlying accelerator-service/duckdb-executor-service units.
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import Database from 'better-sqlite3';
import { eq } from 'drizzle-orm';
import { db } from '../db/client';
import { connections, queryRuns } from '../db/schema';
import { executeQuery } from './query-executor-service';

const CACHE_ROOT = path.join(process.cwd(), '.cache', 'snapshots');
const DB_PATH = path.join(process.cwd(), '.cache', 'query-executor-parity-test.sqlite');

async function createSqliteConnection(accelerateEnabled: boolean) {
  const [row] = await db
    .insert(connections)
    .values({
      name: `parity-test-${accelerateEnabled ? 'accelerated' : 'baseline'}`,
      kind: 'sqlite-file',
      dialect: 'sqlite',
      config: { path: DB_PATH },
      secretEncrypted: null,
      isReadOnlyVerified: true,
      accelerateEnabled,
      accelerateTtlMs: 60_000,
    })
    .returning();
  return row;
}

describe('executeQuery accelerator parity', () => {
  beforeAll(async () => {
    await rm(DB_PATH, { force: true });
    const sqlite = new Database(DB_PATH);
    sqlite.exec(`
      CREATE TABLE orders (id INTEGER PRIMARY KEY, customer_id INTEGER, amount REAL, status TEXT);
    `);
    const insert = sqlite.prepare('INSERT INTO orders (id, customer_id, amount, status) VALUES (?, ?, ?, ?)');
    // No index on customer_id/status → a WHERE-less full scan (EXPLAIN QUERY PLAN
    // reports SCAN), which is what pushes SQLite's risk score into medium tier
    // (assessRisk falls back to hasFullScan when estimatedRows is null).
    for (let i = 1; i <= 50; i++) {
      insert.run(i, i % 5, i * 10.5, i % 2 === 0 ? 'paid' : 'pending');
    }
    sqlite.close();
  });

  afterEach(async () => {
    await db.delete(queryRuns).where(eq(queryRuns.connectionId, baselineConn.id));
    await db.delete(queryRuns).where(eq(queryRuns.connectionId, acceleratedConn.id));
  });

  let baselineConn: Awaited<ReturnType<typeof createSqliteConnection>>;
  let acceleratedConn: Awaited<ReturnType<typeof createSqliteConnection>>;

  it('produces identical rows/columns whether or not the connection has the accelerator enabled', async () => {
    baselineConn = await createSqliteConnection(false);
    acceleratedConn = await createSqliteConnection(true);
    const sql = 'SELECT id, customer_id, amount, status FROM orders ORDER BY id';

    try {
      const baseline = await executeQuery({ connectionId: baselineConn.id, sql, confirmed: true });
      const accelerated = await executeQuery({ connectionId: acceleratedConn.id, sql, confirmed: true });

      expect(baseline.status).toBe('ok');
      expect(accelerated.status).toBe('ok');
      expect(baseline.result?.accelerated).toBeUndefined();
      expect(accelerated.result?.accelerated).toBeDefined();

      expect(accelerated.result?.columns).toEqual(baseline.result?.columns);
      expect(accelerated.result?.rowCount).toEqual(baseline.result?.rowCount);
      // BIGINT columns come back as native `bigint` from DuckDB but as JS
      // `number` from better-sqlite3 — normalize before comparing so the test
      // asserts value equality, not representation equality.
      const normalize = (rows: unknown[][] | undefined) =>
        (rows ?? []).map((r) => r.map((v) => (typeof v === 'bigint' ? Number(v) : v)));
      expect(normalize(accelerated.result?.rows)).toEqual(normalize(baseline.result?.rows));
    } finally {
      await db.delete(connections).where(eq(connections.id, baselineConn.id));
      await db.delete(connections).where(eq(connections.id, acceleratedConn.id));
      await rm(path.join(CACHE_ROOT, acceleratedConn.id), { recursive: true, force: true });
      await rm(DB_PATH, { force: true });
    }
  });

  it('falls back to a live, non-accelerated result when the DuckDB path itself throws', async () => {
    // A pre-poisoned snapshot cache directory (a plain file where DuckDB's
    // Parquet writer needs to create a directory) makes `ensureSnapshot`
    // throw mid-extract — forcing `tryAccelerate`'s try/catch
    // (query-executor-service.ts) to actually exercise its catch branch,
    // not just its "planAcceleration returned an error string" branch
    // (already covered by the parity test above). The live driver is
    // completely unaffected by this, so the fallback must still succeed.
    const sqlite = new Database(DB_PATH);
    sqlite.exec('CREATE TABLE orders (id INTEGER PRIMARY KEY, customer_id INTEGER, amount REAL, status TEXT);');
    const insert = sqlite.prepare('INSERT INTO orders (id, customer_id, amount, status) VALUES (?, ?, ?, ?)');
    for (let i = 1; i <= 50; i++) insert.run(i, i % 5, i * 10.5, i % 2 === 0 ? 'paid' : 'pending');
    sqlite.close();

    const conn = await createSqliteConnection(true);
    const { mkdir, writeFile } = await import('node:fs/promises');
    await mkdir(CACHE_ROOT, { recursive: true });
    await writeFile(path.join(CACHE_ROOT, conn.id), 'not a directory');

    try {
      const sql = 'SELECT id, customer_id, amount, status FROM orders ORDER BY id';
      const result = await executeQuery({ connectionId: conn.id, sql, confirmed: true });

      expect(result.status).toBe('ok');
      expect(result.result?.accelerated).toBeUndefined();
      expect(result.result?.rowCount).toBe(50);
    } finally {
      await rm(path.join(CACHE_ROOT, conn.id), { recursive: true, force: true });
      await db.delete(queryRuns).where(eq(queryRuns.connectionId, conn.id));
      await db.delete(connections).where(eq(connections.id, conn.id));
      await rm(DB_PATH, { force: true });
    }
  });
});
