import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { DuckDBInstance } from '@duckdb/node-api';
import { ensureIncrementalSnapshot } from './incremental-snapshot-service';
import type { ConnectionProvider, QueryResult } from './connection-providers/provider-interface';

const CACHE_ROOT = path.join(process.cwd(), '.cache', 'snapshots');

function sequencedProvider(results: QueryResult[]): ConnectionProvider {
  const executeReadOnly = vi.fn();
  results.forEach((r) => executeReadOnly.mockResolvedValueOnce(r));
  return {
    dialect: 'postgres',
    testConnection: vi.fn(),
    probeWritePrivilege: vi.fn(),
    introspectSchema: vi.fn(),
    executeReadOnly,
    explainQuery: vi.fn(),
    close: vi.fn(),
  } as unknown as ConnectionProvider;
}

async function readParquetRows(parquetPath: string) {
  const instance = await DuckDBInstance.create(':memory:');
  const connection = await instance.connect();
  try {
    const reader = await connection.runAndReadAll(`SELECT * FROM read_parquet('${parquetPath.replace(/'/g, "''")}') ORDER BY id`);
    return reader.getRowsJson();
  } finally {
    connection.closeSync();
  }
}

describe('ensureIncrementalSnapshot', () => {
  const connectionId = 'test-connection-incremental-snapshot';

  beforeEach(async () => {
    await rm(path.join(CACHE_ROOT, connectionId), { recursive: true, force: true });
  });

  afterEach(async () => {
    await rm(path.join(CACHE_ROOT, connectionId), { recursive: true, force: true });
  });

  it('does a full extract on first run and seeds the watermark from the max column value', async () => {
    const provider = sequencedProvider([
      {
        columns: ['id', 'updated_at'],
        rows: [
          [1n, new Date('2026-01-01T00:00:00.000Z')],
          [2n, new Date('2026-01-02T00:00:00.000Z')],
        ],
        rowCount: 2,
      },
    ]);

    const snapshot = await ensureIncrementalSnapshot(connectionId, provider, 'SELECT * FROM t', 'updated_at', 60_000);
    const rows = await readParquetRows(snapshot.path);

    expect(provider.executeReadOnly).toHaveBeenCalledTimes(1);
    expect(rows).toHaveLength(2);
  });

  it('extracts only the delta and appends it once the TTL expires, advancing the watermark', async () => {
    const provider = sequencedProvider([
      {
        columns: ['id', 'updated_at'],
        rows: [[1n, new Date('2026-01-01T00:00:00.000Z')]],
        rowCount: 1,
      },
      {
        columns: ['id', 'updated_at'],
        rows: [[2n, new Date('2026-01-02T00:00:00.000Z')]],
        rowCount: 1,
      },
    ]);

    await ensureIncrementalSnapshot(connectionId, provider, 'SELECT * FROM t', 'updated_at', 1);
    await new Promise((r) => setTimeout(r, 10));
    const second = await ensureIncrementalSnapshot(connectionId, provider, 'SELECT * FROM t', 'updated_at', 1);
    const rows = await readParquetRows(second.path);

    expect(provider.executeReadOnly).toHaveBeenCalledTimes(2);
    // Second call's SQL must filter on the seeded watermark, not re-select everything.
    const deltaSql = (provider.executeReadOnly as ReturnType<typeof vi.fn>).mock.calls[1][0] as string;
    expect(deltaSql).toContain('updated_at');
    expect(deltaSql).toContain('2026-01-01');
    // Old + new rows both present after append.
    expect(rows).toHaveLength(2);
    expect(rows[0][0]).toBe('1');
    expect(rows[1][0]).toBe('2');
  });

  it('leaves the Parquet file untouched (no rewrite) when the delta is empty, but refreshes asOf', async () => {
    const provider = sequencedProvider([
      {
        columns: ['id', 'updated_at'],
        rows: [[1n, new Date('2026-01-01T00:00:00.000Z')]],
        rowCount: 1,
      },
      { columns: ['id', 'updated_at'], rows: [], rowCount: 0 },
    ]);

    const first = await ensureIncrementalSnapshot(connectionId, provider, 'SELECT * FROM t', 'updated_at', 1);
    await new Promise((r) => setTimeout(r, 10));
    const second = await ensureIncrementalSnapshot(connectionId, provider, 'SELECT * FROM t', 'updated_at', 1);
    const rows = await readParquetRows(second.path);

    expect(second.path).toBe(first.path);
    expect(second.asOf.getTime()).toBeGreaterThan(first.asOf.getTime());
    expect(rows).toHaveLength(1);
  });

  it('reuses the cache within TTL without querying the source again', async () => {
    const provider = sequencedProvider([
      { columns: ['id', 'updated_at'], rows: [[1n, new Date('2026-01-01T00:00:00.000Z')]], rowCount: 1 },
    ]);

    await ensureIncrementalSnapshot(connectionId, provider, 'SELECT * FROM t', 'updated_at', 60_000);
    await ensureIncrementalSnapshot(connectionId, provider, 'SELECT * FROM t', 'updated_at', 60_000);

    expect(provider.executeReadOnly).toHaveBeenCalledTimes(1);
  });

  it('rejects a watermark column that is not a plain identifier, before ever touching the provider', async () => {
    const provider = sequencedProvider([]);

    await expect(
      ensureIncrementalSnapshot(connectionId, provider, 'SELECT * FROM t', 'updated_at" OR 1=1 --', 60_000),
    ).rejects.toThrow(/Invalid watermark column name/);
    expect(provider.executeReadOnly).not.toHaveBeenCalled();
  });

  it('widens a delta batch whose values look narrower (all-integer) than an existing DOUBLE column', async () => {
    const provider = sequencedProvider([
      {
        columns: ['id', 'amount'],
        rows: [[1n, 1.5]], // fractional -> existing column is inferred/created as DOUBLE
        rowCount: 1,
      },
      {
        columns: ['id', 'amount'],
        rows: [[2n, 5n]], // all-integer delta -> inferColumnPlans would type this BIGINT
        rowCount: 1,
      },
    ]);

    await ensureIncrementalSnapshot(connectionId, provider, 'SELECT * FROM t', 'id', 1);
    await new Promise((r) => setTimeout(r, 10));

    const second = await ensureIncrementalSnapshot(connectionId, provider, 'SELECT * FROM t', 'id', 1);
    const rows = await readParquetRows(second.path);

    expect(rows).toHaveLength(2);
    expect(rows[0][1]).toBe(1.5);
    expect(rows[1][1]).toBe(5);
  });

  it('widens a delta batch whose values look narrower than an existing VARCHAR column', async () => {
    const provider = sequencedProvider([
      {
        columns: ['id', 'label'],
        rows: [[1n, 'active']], // string -> existing column is inferred/created as VARCHAR
        rowCount: 1,
      },
      {
        columns: ['id', 'label'],
        rows: [[2n, 42n]], // all-numeric delta -> inferColumnPlans would type this BIGINT
        rowCount: 1,
      },
    ]);

    await ensureIncrementalSnapshot(connectionId, provider, 'SELECT * FROM t', 'id', 1);
    await new Promise((r) => setTimeout(r, 10));

    const second = await ensureIncrementalSnapshot(connectionId, provider, 'SELECT * FROM t', 'id', 1);
    const rows = await readParquetRows(second.path);

    expect(rows).toHaveLength(2);
    expect(rows[0][1]).toBe('active');
    expect(rows[1][1]).toBe('42');
  });

  it('includes a row whose watermark was NULL at first extract and later gets populated', async () => {
    const provider = sequencedProvider([
      {
        columns: ['id', 'updated_at'],
        rows: [
          [1n, new Date('2026-01-01T00:00:00.000Z')],
          [2n, null], // never-updated row — NULL watermark at first extract
        ],
        rowCount: 2,
      },
      {
        columns: ['id', 'updated_at'],
        rows: [[2n, new Date('2026-01-03T00:00:00.000Z')]], // row 2 finally updated
        rowCount: 1,
      },
    ]);

    await ensureIncrementalSnapshot(connectionId, provider, 'SELECT * FROM t', 'updated_at', 1);
    await new Promise((r) => setTimeout(r, 10));
    await ensureIncrementalSnapshot(connectionId, provider, 'SELECT * FROM t', 'updated_at', 1);

    // The delta SQL must COALESCE the NULL-able watermark column to a floor
    // value strictly below the seeded watermark ('2026-01-01...', from row 1 —
    // row 2's NULL is skipped by maxWatermark), so a row whose watermark is
    // still NULL is never excluded from a delta by an unmatched
    // `NULL > value` comparison, and the floor itself never exceeds the real
    // seeded watermark (which would wrongly re-include every still-NULL row
    // on every delta forever).
    const deltaSql = (provider.executeReadOnly as ReturnType<typeof vi.fn>).mock.calls[1][0] as string;
    expect(deltaSql).toMatch(/COALESCE\("updated_at",\s*'0001-01-01T00:00:00\.000Z'\)\s*>\s*'2026-01-01T00:00:00\.000Z'/);
  });

  it('widens an existing BIGINT column to DOUBLE when a delta batch has a fractional value', async () => {
    const provider = sequencedProvider([
      {
        columns: ['id', 'amount'],
        rows: [[1n, 5n]], // integer-only -> existing column is BIGINT
        rowCount: 1,
      },
      {
        columns: ['id', 'amount'],
        rows: [[2n, 2.5]], // fractional delta -> must widen BIGINT to DOUBLE, not throw
        rowCount: 1,
      },
    ]);

    await ensureIncrementalSnapshot(connectionId, provider, 'SELECT * FROM t', 'id', 1);
    await new Promise((r) => setTimeout(r, 10));

    const second = await ensureIncrementalSnapshot(connectionId, provider, 'SELECT * FROM t', 'id', 1);
    const rows = await readParquetRows(second.path);
    expect(rows).toHaveLength(2);
  });
});
