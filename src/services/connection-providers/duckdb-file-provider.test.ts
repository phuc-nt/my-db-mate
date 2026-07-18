/**
 * DuckDB file provider — integration over real fixture files in ./data-files
 * (created by the test setup). Asserts the security-critical behavior:
 *  - all 3 source modes ingest + query,
 *  - after ingest the filesystem is LOCKED (replacement scan / read_text /
 *    read_csv / re-enable all fail FROM THE ENGINE, not the denylist),
 *  - the path sandbox rejects escapes (absolute outside root, traversal),
 *  - a runaway query is killed by the timeout.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DuckDBInstance } from '@duckdb/node-api';
import { mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { DuckDbFileProvider } from './duckdb-file-provider';

const ROOT = resolve(process.cwd(), 'data-files-test');
process.env.DUCKDB_DATA_DIR = ROOT;

beforeAll(async () => {
  rmSync(ROOT, { recursive: true, force: true });
  mkdirSync(`${ROOT}/csv`, { recursive: true });
  const inst = await DuckDBInstance.create(':memory:');
  const c = await inst.connect();
  await c.run(`CREATE TABLE orders AS SELECT range AS id, (range % 3) AS status, range*1.5 AS amount FROM range(100)`);
  await c.run(`COPY orders TO '${ROOT}/orders.parquet' (FORMAT parquet)`);
  await c.run(`COPY orders TO '${ROOT}/csv/orders.csv' (FORMAT csv, HEADER)`);
  const inst2 = await DuckDBInstance.create(`${ROOT}/shop.duckdb`);
  const c2 = await inst2.connect();
  await c2.run(`CREATE TABLE customers AS SELECT range AS id, 'c'||range AS name FROM range(50)`);
  // A DECIMAL column (10.0 literal) — node-api returns DuckDBDecimalValue{value:bigint},
  // which must be normalized or it throws "Do not know how to serialize a BigInt" at IPC.
  await c2.run(`CREATE TABLE sales AS SELECT range AS id, range*10.0 AS revenue, range::HUGEINT AS big FROM range(20)`);
  await c2.run(`CHECKPOINT`);
  // Release the write lock so the provider's READ_ONLY attach can open the file.
  c2.closeSync?.();
  inst2.closeSync?.();
});
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

describe('DuckDbFileProvider — source modes', () => {
  it('queries a parquet file', async () => {
    const p = new DuckDbFileProvider({ mode: 'parquet', path: `${ROOT}/orders.parquet` });
    const res = await p.executeReadOnly('SELECT count(*) AS n FROM orders');
    expect(Number(res.rows[0][0])).toBe(100);
  });

  it('queries a csv directory (one table per file)', async () => {
    const p = new DuckDbFileProvider({ mode: 'csv-dir', path: `${ROOT}/csv` });
    const schema = await p.introspectSchema();
    expect(schema.tables.map((t) => t.tableName)).toContain('orders');
    const res = await p.executeReadOnly('SELECT count(*) AS n FROM orders');
    expect(Number(res.rows[0][0])).toBe(100);
  });

  it('queries a .duckdb file (READ_ONLY attach)', async () => {
    const p = new DuckDbFileProvider({ mode: 'duckdb', path: `${ROOT}/shop.duckdb` });
    const res = await p.executeReadOnly('SELECT count(*) AS n FROM customers');
    expect(Number(res.rows[0][0])).toBe(50);
  });

  it('serializes DECIMAL and HUGEINT columns without a BigInt error', async () => {
    const p = new DuckDbFileProvider({ mode: 'duckdb', path: `${ROOT}/shop.duckdb` });
    const res = await p.executeReadOnly('SELECT id, revenue, big FROM sales ORDER BY id LIMIT 3');
    // revenue = id*10.0 (DECIMAL → number), big = id (HUGEINT → number). Both JSON-safe.
    expect(res.rows).toEqual([[0, 0, 0], [1, 10, 1], [2, 20, 2]]);
    expect(() => JSON.stringify(res.rows)).not.toThrow();
  });

  it('introspects columns', async () => {
    const p = new DuckDbFileProvider({ mode: 'parquet', path: `${ROOT}/orders.parquet` });
    const s = await p.introspectSchema();
    expect(s.columns.map((c) => c.columnName).sort()).toEqual(['amount', 'id', 'status']);
    expect(s.tables[0].rowCount).toBe(100);
  });
});

describe('DuckDbFileProvider — filesystem lockdown (engine, not denylist)', () => {
  const p = () => new DuckDbFileProvider({ mode: 'parquet', path: `${ROOT}/orders.parquet` });
  const secret = '/etc/hosts'; // exists, outside root — a real exfil target shape

  it('blocks a replacement scan of an outside file after ingest', async () => {
    await expect(p().executeReadOnly(`SELECT * FROM '${secret}'`)).rejects.toThrow();
  });
  it('blocks read_text of an outside file after ingest', async () => {
    await expect(p().executeReadOnly(`SELECT * FROM read_text('${secret}')`)).rejects.toThrow();
  });
  it('blocks read_csv of an outside file after ingest', async () => {
    await expect(p().executeReadOnly(`SELECT * FROM read_csv_auto('${secret}')`)).rejects.toThrow();
  });
  it('blocks re-enabling external access after the lock', async () => {
    await expect(p().executeReadOnly(`SET enable_external_access = true`)).rejects.toThrow();
  });
});

describe('DuckDbFileProvider — path sandbox', () => {
  it('rejects an absolute path outside the data root', async () => {
    const p = new DuckDbFileProvider({ mode: 'duckdb', path: '/etc/hosts' });
    await expect(p.testConnection()).rejects.toThrow(/outside the allowed data directory|expects a \.duckdb/);
  });
  it('rejects a traversal escape', async () => {
    const p = new DuckDbFileProvider({ mode: 'parquet', path: `${ROOT}/../../../etc/hosts` });
    await expect(p.testConnection()).rejects.toThrow(/outside the allowed data directory|not found|expects a \.parquet/);
  });
  it('rejects a missing file', async () => {
    const p = new DuckDbFileProvider({ mode: 'parquet', path: `${ROOT}/nope.parquet` });
    await expect(p.testConnection()).rejects.toThrow(/not found/);
  });
});

describe('DuckDbFileProvider — kill timeout', () => {
  it('terminates a runaway query', async () => {
    const p = new DuckDbFileProvider({ mode: 'parquet', path: `${ROOT}/orders.parquet` });
    // A cartesian explosion over generate_series; killed by the short timeout.
    await expect(
      p.executeReadOnly('SELECT count(*) FROM range(100000000) a, range(100000000) b', { timeoutMs: 800 }),
    ).rejects.toThrow(/exceeded 800ms|terminated/);
  });
});
