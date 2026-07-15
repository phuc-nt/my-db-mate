import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { DuckDBInstance } from '@duckdb/node-api';
import { ensureSnapshot } from './snapshot-cache-service';
import type { ConnectionProvider, QueryResult } from './connection-providers/provider-interface';

const CACHE_ROOT = path.join(process.cwd(), '.cache', 'snapshots');

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
