import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { and, eq } from 'drizzle-orm';
import { DuckDBInstance } from '@duckdb/node-api';
import { db } from '../../db/client';
import { accelerateSnapshots, connections } from '../../db/schema';
import { cacheKeyFor, ensureSnapshot, parquetCopyOptions } from './snapshot-cache-service';
import type { ConnectionProvider, QueryResult } from '../connection-providers/provider-interface';

const CACHE_ROOT = path.join(process.cwd(), '.cache', 'snapshots');

async function createFixtureConnection() {
  const [row] = await db
    .insert(connections)
    .values({
      name: 'snapshot-cache-status-test',
      kind: 'sqlite-file',
      dialect: 'sqlite',
      config: { path: '/tmp/unused-for-this-test.sqlite' },
      secretEncrypted: null,
      isReadOnlyVerified: true,
      accelerateEnabled: true,
      accelerateTtlMs: 60_000,
    })
    .returning();
  return row;
}

function fakeProvider(result: QueryResult): ConnectionProvider {
  return {
    dialect: 'postgres',
    testConnection: vi.fn(),
    probeWritePrivilege: vi.fn(),
    introspectSchema: vi.fn(),
    executeReadOnly: vi.fn().mockResolvedValue(result),
    explainQuery: vi.fn(),
    close: vi.fn(),
  } as unknown as ConnectionProvider;
}

async function readParquetRows(parquetPath: string) {
  const instance = await DuckDBInstance.create(':memory:');
  const connection = await instance.connect();
  try {
    const reader = await connection.runAndReadAll(`SELECT * FROM read_parquet('${parquetPath.replace(/'/g, "''")}')`);
    return { rows: reader.getRowsJson(), types: reader.columnTypes().map((t) => t.toString()) };
  } finally {
    connection.closeSync();
  }
}

describe('ensureSnapshot', () => {
  const connectionId = 'test-connection-snapshot-cache';

  beforeEach(async () => {
    await rm(path.join(CACHE_ROOT, connectionId), { recursive: true, force: true });
  });

  afterEach(async () => {
    await rm(path.join(CACHE_ROOT, connectionId), { recursive: true, force: true });
  });

  it('extracts once and reuses the cache within TTL', async () => {
    const result: QueryResult = {
      columns: ['id', 'name'],
      rows: [
        [1n, 'a'],
        [2n, 'b'],
      ],
      rowCount: 2,
    };
    const provider = fakeProvider(result);

    const first = await ensureSnapshot(connectionId, provider, 'SELECT id, name FROM t', 60_000);
    const second = await ensureSnapshot(connectionId, provider, 'SELECT id, name FROM t', 60_000);

    expect(provider.executeReadOnly).toHaveBeenCalledTimes(1);
    expect(second.path).toBe(first.path);
    expect(second.asOf).toEqual(first.asOf);
  });

  it('re-extracts after TTL expires', async () => {
    const result: QueryResult = { columns: ['id'], rows: [[1n]], rowCount: 1 };
    const provider = fakeProvider(result);

    await ensureSnapshot(connectionId, provider, 'SELECT id FROM t', 1);
    await new Promise((r) => setTimeout(r, 10));
    await ensureSnapshot(connectionId, provider, 'SELECT id FROM t', 1);

    expect(provider.executeReadOnly).toHaveBeenCalledTimes(2);
  });

  it('ttlMs=0 forces a re-extract even when the existing cache is still fresh (Phase 3 manual refresh)', async () => {
    const result: QueryResult = { columns: ['id'], rows: [[1n]], rowCount: 1 };
    const provider = fakeProvider(result);

    const first = await ensureSnapshot(connectionId, provider, 'SELECT id FROM t', 60_000);
    const second = await ensureSnapshot(connectionId, provider, 'SELECT id FROM t', 0);

    expect(provider.executeReadOnly).toHaveBeenCalledTimes(2);
    expect(second.asOf.getTime()).toBeGreaterThanOrEqual(first.asOf.getTime());
  });

  it('preserves numeric, text, and timestamp types through the Parquet round-trip', async () => {
    const result: QueryResult = {
      columns: ['id', 'amount', 'label', 'created_at', 'nullable_col'],
      rows: [
        [1n, 9.5, 'first', new Date('2026-01-01T00:00:00.000Z'), null],
        [2n, 10, 'second', new Date('2026-01-02T00:00:00.000Z'), 'has-value'],
      ],
      rowCount: 2,
    };
    const provider = fakeProvider(result);

    const snapshot = await ensureSnapshot(connectionId, provider, 'SELECT * FROM t', 60_000);
    const { rows, types } = await readParquetRows(snapshot.path);

    expect(rows).toHaveLength(2);
    expect(rows[0][0]).toBe('1'); // BIGINT serializes as string in JSON form
    expect(rows[0][1]).toBe(9.5);
    expect(rows[0][2]).toBe('first');
    expect(rows[0][3]).toContain('2026-01-01');
    expect(rows[0][4]).toBeNull();
    expect(rows[1][4]).toBe('has-value');
    expect(types.some((t) => t.includes('TIMESTAMP'))).toBe(true);
    expect(types.some((t) => t.includes('DOUBLE'))).toBe(true);
  });

  it('widens a float column to DOUBLE even when an earlier row holds a whole number', async () => {
    // Regression: a `double precision` column (e.g. Postgres trip_distance)
    // where the first non-null row happens to be a whole number (3) used to
    // lock the column to BIGINT via first-sample sniffing, then crash when a
    // later fractional value (3.5) couldn't bind as BigInt.
    const result: QueryResult = {
      columns: ['id', 'trip_distance'],
      rows: [
        [1n, 3],
        [2n, 3.5],
        [3n, 0],
      ],
      rowCount: 3,
    };
    const provider = fakeProvider(result);

    const snapshot = await ensureSnapshot(connectionId, provider, 'SELECT id, trip_distance FROM t', 60_000);
    const { rows, types } = await readParquetRows(snapshot.path);

    expect(rows).toHaveLength(3);
    expect(rows[0][1]).toBe(3);
    expect(rows[1][1]).toBe(3.5);
    expect(rows[2][1]).toBe(0);
    expect(types[1]).toContain('DOUBLE');
  });

  it('handles a fully-null column by falling back to VARCHAR', async () => {
    const result: QueryResult = {
      columns: ['id', 'always_null'],
      rows: [
        [1n, null],
        [2n, null],
      ],
      rowCount: 2,
    };
    const provider = fakeProvider(result);

    const snapshot = await ensureSnapshot(connectionId, provider, 'SELECT id, always_null FROM t', 60_000);
    const { rows } = await readParquetRows(snapshot.path);

    expect(rows[0][1]).toBeNull();
    expect(rows[1][1]).toBeNull();
  });

  it('handles an empty result set', async () => {
    const result: QueryResult = { columns: ['id', 'name'], rows: [], rowCount: 0 };
    const provider = fakeProvider(result);

    const snapshot = await ensureSnapshot(connectionId, provider, 'SELECT id, name FROM t WHERE 1=0', 60_000);
    const { rows } = await readParquetRows(snapshot.path);

    expect(rows).toHaveLength(0);
  });
});

describe('ensureSnapshot — accelerateSnapshots status persistence', () => {
  let conn: Awaited<ReturnType<typeof createFixtureConnection>>;

  beforeEach(async () => {
    conn = await createFixtureConnection();
    await rm(path.join(CACHE_ROOT, conn.id), { recursive: true, force: true });
  });

  afterEach(async () => {
    await db.delete(accelerateSnapshots).where(eq(accelerateSnapshots.connectionId, conn.id));
    await db.delete(connections).where(eq(connections.id, conn.id));
    await rm(path.join(CACHE_ROOT, conn.id), { recursive: true, force: true });
  });

  it('writes a ready row with asOf and sizeBytes after a successful extract', async () => {
    const sql = 'SELECT id, name FROM t';
    const provider = fakeProvider({ columns: ['id', 'name'], rows: [[1n, 'a']], rowCount: 1 });

    await ensureSnapshot(conn.id, provider, sql, 60_000);

    const [row] = await db
      .select()
      .from(accelerateSnapshots)
      .where(and(eq(accelerateSnapshots.connectionId, conn.id), eq(accelerateSnapshots.cacheKey, cacheKeyFor(sql))));

    expect(row).toBeDefined();
    expect(row.status).toBe('ready');
    expect(row.asOf).not.toBeNull();
    expect(row.sizeBytes).not.toBeNull();
    expect(row.lastError).toBeNull();
  });

  it('writes a failed row with lastError when extraction throws, without throwing itself from the status write', async () => {
    const sql = 'SELECT id FROM broken_table';
    const provider: ConnectionProvider = {
      dialect: 'postgres',
      testConnection: vi.fn(),
      probeWritePrivilege: vi.fn(),
      introspectSchema: vi.fn(),
      executeReadOnly: vi.fn().mockRejectedValue(new Error('boom')),
      explainQuery: vi.fn(),
      close: vi.fn(),
    } as unknown as ConnectionProvider;

    await expect(ensureSnapshot(conn.id, provider, sql, 60_000)).rejects.toThrow('boom');

    const [row] = await db
      .select()
      .from(accelerateSnapshots)
      .where(and(eq(accelerateSnapshots.connectionId, conn.id), eq(accelerateSnapshots.cacheKey, cacheKeyFor(sql))));

    expect(row).toBeDefined();
    expect(row.status).toBe('failed');
    expect(row.lastError).toContain('boom');
  });

  it('does not break extraction when the status upsert itself fails (best-effort, non-throwing)', async () => {
    const sql = 'SELECT id, name FROM t';
    const provider = fakeProvider({ columns: ['id', 'name'], rows: [[1n, 'a']], rowCount: 1 });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const insertSpy = vi.spyOn(db, 'insert').mockImplementation(() => {
      throw new Error('db unavailable');
    });

    try {
      const result = await ensureSnapshot(conn.id, provider, sql, 60_000);
      expect(result.path).toBeTruthy();
      expect(warnSpy).toHaveBeenCalledWith(
        '[accelerator] failed to persist snapshot status (non-fatal):',
        expect.any(String),
      );
    } finally {
      insertSpy.mockRestore();
      warnSpy.mockRestore();
    }
  });
});

describe('parquetCopyOptions (Phase 3: threshold-triggered compression)', () => {
  it('keeps the default, unqualified FORMAT PARQUET at or below the 1,000,000-row threshold', () => {
    expect(parquetCopyOptions(0)).toBe('(FORMAT PARQUET)');
    expect(parquetCopyOptions(1_000_000)).toBe('(FORMAT PARQUET)');
  });

  it('adds ZSTD compression and a 500,000-row group size once the row count exceeds the threshold', () => {
    expect(parquetCopyOptions(1_000_001)).toBe('(FORMAT PARQUET, COMPRESSION ZSTD, ROW_GROUP_SIZE 500000)');
  });
});
