import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DuckDBInstance } from '@duckdb/node-api';
import { runAcceleratedQuery } from './duckdb-executor-service';

async function writeParquet(rows: { sql: string }, columns: string, values: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'duckdb-executor-test-'));
  const parquetPath = path.join(dir, 'snapshot.parquet');
  const instance = await DuckDBInstance.create(':memory:');
  const connection = await instance.connect();
  try {
    await connection.run(`CREATE TABLE t (${columns})`);
    if (values) await connection.run(`INSERT INTO t VALUES ${values}`);
    await connection.run(`COPY t TO '${parquetPath.replace(/'/g, "''")}' (FORMAT PARQUET)`);
  } finally {
    connection.closeSync();
  }
  return parquetPath;
}

const cleanupDirs: string[] = [];
afterEach(async () => {
  await Promise.all(cleanupDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

describe('runAcceleratedQuery', () => {
  it('runs the original SQL unmodified against a single snapshot view', async () => {
    const parquetPath = await writeParquet(
      { sql: '' },
      'id BIGINT, amount DOUBLE, label VARCHAR',
      "(1, 9.5, 'a'), (2, 20, 'b'), (3, 5, 'a')",
    );
    cleanupDirs.push(path.dirname(parquetPath));

    const result = await runAcceleratedQuery('SELECT label, SUM(amount) AS total FROM orders GROUP BY label ORDER BY label', new Map([
      ['orders', parquetPath],
    ]));

    expect(result.columns).toEqual(['label', 'total']);
    expect(result.rows).toEqual([
      ['a', 14.5],
      ['b', 20],
    ]);
    expect(result.rowCount).toBe(2);
  });

  it('joins across two snapshot views', async () => {
    const ordersPath = await writeParquet({ sql: '' }, 'id BIGINT, customer_id BIGINT', '(1, 10), (2, 20)');
    cleanupDirs.push(path.dirname(ordersPath));
    const customersPath = await writeParquet({ sql: '' }, 'id BIGINT, name VARCHAR', "(10, 'Alice'), (20, 'Bob')");
    cleanupDirs.push(path.dirname(customersPath));

    const result = await runAcceleratedQuery(
      'SELECT c.name, o.id AS order_id FROM orders o JOIN customers c ON o.customer_id = c.id ORDER BY o.id',
      new Map([
        ['orders', ordersPath],
        ['customers', customersPath],
      ]),
    );

    expect(result.columns).toEqual(['name', 'order_id']);
    expect(result.rows).toEqual([
      ['Alice', 1],
      ['Bob', 2],
    ]);
  });

  it('supports schema-qualified table names', async () => {
    const parquetPath = await writeParquet({ sql: '' }, 'id BIGINT', '(1), (2)');
    cleanupDirs.push(path.dirname(parquetPath));

    const result = await runAcceleratedQuery('SELECT COUNT(*) AS n FROM public.orders', new Map([
      ['public.orders', parquetPath],
    ]));

    expect(result.rows).toEqual([[2]]);
  });

  it('normalizes BIGINT columns to plain numbers (JSON.stringify cannot serialize bigint)', async () => {
    const parquetPath = await writeParquet({ sql: '' }, 'id BIGINT, amount DOUBLE', '(1, 10.5), (2, 21)');
    cleanupDirs.push(path.dirname(parquetPath));

    const result = await runAcceleratedQuery('SELECT id, amount FROM orders ORDER BY id', new Map([
      ['orders', parquetPath],
    ]));

    expect(result.rows.flat().every((v) => typeof v !== 'bigint')).toBe(true);
    expect(() => JSON.stringify(result)).not.toThrow();
    expect(result.rows).toEqual([[1, 10.5], [2, 21]]);
  });
});
