/**
 * Integration parity test (Phase 2, Implementation Step 7): accelerated and
 * non-accelerated runs of the identical SQL against the identical SQLite data
 * must return row-for-row identical results through `executeQuery()` itself —
 * not just the underlying accelerator-service/duckdb-executor-service units.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import Database from 'better-sqlite3';
import { eq } from 'drizzle-orm';
import { db } from '../db/client';
import { connections, queryRuns } from '../db/schema';
import { executeQuery } from './query-executor-service';
import { cacheKeyFor } from './snapshot-cache-service';

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

  it('logs (not throws) when the DuckDB accelerate path itself fails, distinct from "not eligible"', async () => {
    const sqlite = new Database(DB_PATH);
    sqlite.exec('CREATE TABLE orders (id INTEGER PRIMARY KEY, customer_id INTEGER, amount REAL, status TEXT);');
    const insert = sqlite.prepare('INSERT INTO orders (id, customer_id, amount, status) VALUES (?, ?, ?, ?)');
    for (let i = 1; i <= 50; i++) insert.run(i, i % 5, i * 10.5, i % 2 === 0 ? 'paid' : 'pending');
    sqlite.close();

    const conn = await createSqliteConnection(true);
    const { mkdir } = await import('node:fs/promises');
    await mkdir(CACHE_ROOT, { recursive: true });
    await writeFile(path.join(CACHE_ROOT, conn.id), 'not a directory');
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      const sql = 'SELECT id, customer_id, amount, status FROM orders ORDER BY id';
      await executeQuery({ connectionId: conn.id, sql, confirmed: true });

      // `sql` here is pre-safety-gate; the logged sql is `finalSql` (validateSql
      // injects a LIMIT when the query has none) — assert on the distinguishing
      // fields (error present, not the whole SQL) rather than an exact string.
      expect(warnSpy).toHaveBeenCalledWith(
        '[accelerator] DuckDB execution failed, falling back to live driver:',
        expect.objectContaining({ sql: expect.stringContaining(sql), error: expect.any(String) }),
      );
    } finally {
      warnSpy.mockRestore();
      await rm(path.join(CACHE_ROOT, conn.id), { recursive: true, force: true });
      await db.delete(queryRuns).where(eq(queryRuns.connectionId, conn.id));
      await db.delete(connections).where(eq(connections.id, conn.id));
      await rm(DB_PATH, { force: true });
    }
  });

  it('surfaces a skewWarning when a JOIN\'s per-table snapshots were extracted far apart in time', async () => {
    const sqlite = new Database(DB_PATH);
    sqlite.exec(`
      CREATE TABLE orders (id INTEGER PRIMARY KEY, customer_id INTEGER);
      CREATE TABLE customers (id INTEGER PRIMARY KEY, name TEXT);
    `);
    const insertOrder = sqlite.prepare('INSERT INTO orders (id, customer_id) VALUES (?, ?)');
    const insertCustomer = sqlite.prepare('INSERT INTO customers (id, name) VALUES (?, ?)');
    for (let i = 1; i <= 50; i++) insertOrder.run(i, i % 5);
    for (let i = 0; i < 5; i++) insertCustomer.run(i, `customer-${i}`);
    sqlite.close();

    // Short TTL so a manually-backdated `asOf` (below) reliably exceeds the
    // service's SKEW_THRESHOLD_FRACTION (0.5) of the TTL without needing a
    // real wall-clock wait between the two tables' extractions.
    const ttlMs = 2_000;
    const [conn] = await db
      .insert(connections)
      .values({
        name: 'skew-test',
        kind: 'sqlite-file',
        dialect: 'sqlite',
        config: { path: DB_PATH },
        secretEncrypted: null,
        isReadOnlyVerified: true,
        accelerateEnabled: true,
        accelerateTtlMs: ttlMs,
      })
      .returning();

    try {
      const sql = 'SELECT o.id, c.name FROM orders o JOIN customers c ON o.customer_id = c.id ORDER BY o.id';
      const result = await executeQuery({ connectionId: conn.id, sql, confirmed: true });
      expect(result.status).toBe('ok');
      expect(result.result?.accelerated).toBeDefined();
      // First run: both snapshots freshly extracted, no meaningful skew yet.
      expect(result.result?.accelerated?.skewWarning).toBeUndefined();

      // Backdate the customers snapshot's `asOf` well past the skew threshold
      // (> 50% of the bumped TTL below) while leaving the orders snapshot
      // fresh. Bump `accelerateTtlMs` for the second call to a value large
      // enough that neither snapshot's TTL has actually expired (so
      // `ensureSnapshot` reuses both as-is instead of re-extracting) while
      // still keeping the backdated gap comfortably over half of it.
      const newTtlMs = 60_000;
      const customersCacheKey = cacheKeyFor('SELECT * FROM customers');
      const customersMetaPath = path.join(CACHE_ROOT, conn.id, `${customersCacheKey}.meta.json`);
      const staleAsOf = new Date(Date.now() - newTtlMs * 0.9).toISOString();
      await writeFile(customersMetaPath, JSON.stringify({ asOf: staleAsOf }), 'utf-8');
      await db.update(connections).set({ accelerateTtlMs: newTtlMs }).where(eq(connections.id, conn.id));

      const skewed = await executeQuery({ connectionId: conn.id, sql, confirmed: true });
      expect(skewed.status).toBe('ok');
      expect(skewed.result?.accelerated?.skewWarning).toBeDefined();
      expect(skewed.result!.accelerated!.skewWarning!.spreadMs).toBeGreaterThan(0);
    } finally {
      await rm(path.join(CACHE_ROOT, conn.id), { recursive: true, force: true });
      await db.delete(queryRuns).where(eq(queryRuns.connectionId, conn.id));
      await db.delete(connections).where(eq(connections.id, conn.id));
      await rm(DB_PATH, { force: true });
    }
  });
});
