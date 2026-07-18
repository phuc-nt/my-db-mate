/**
 * Runs an already-validated SELECT against Parquet snapshots instead of the
 * live driver (Phase 2 accelerator). Each accelerated table gets a DuckDB VIEW
 * pointing at its snapshot file, so the original SQL text runs completely
 * unmodified — no FROM/JOIN AST rewrite needed, which is the main reason this
 * approach was chosen over rewriting table refs to `read_parquet(...)` inline.
 */
import { DuckDBInstance } from '@duckdb/node-api';
import type { QueryResult } from '../connection-providers/provider-interface';
import { normalizeDuckDbValue } from '../../lib/duckdb-value';

/** Quote a possibly schema-qualified identifier for DuckDB DDL — each dotted
 *  part quoted separately so `schema.table` becomes `"schema"."table"`. */
function quoteIdent(name: string): string {
  return name
    .split('.')
    .map((part) => `"${part.replace(/"/g, '""')}"`)
    .join('.');
}

/**
 * `tableToSnapshot` maps each table name exactly as it appeared in `sql`'s
 * FROM/JOIN clauses (from `extractTableNames()`) to its local Parquet snapshot
 * path. Returns rows in the same shape as `provider.executeReadOnly()`.
 */
export async function runAcceleratedQuery(sql: string, tableToSnapshot: Map<string, string>): Promise<QueryResult> {
  const instance = await DuckDBInstance.create(':memory:');
  const connection = await instance.connect();
  try {
    // A schema-qualified table name (e.g. `public.orders`) needs its schema to
    // exist before the view can be created inside it — DuckDB's in-memory
    // instance starts with only `main`.
    const schemas = new Set(
      [...tableToSnapshot.keys()].map((t) => t.split('.')).filter((parts) => parts.length > 1).map((parts) => parts[0]),
    );
    for (const schema of schemas) {
      await connection.run(`CREATE SCHEMA IF NOT EXISTS ${quoteIdent(schema)}`);
    }

    for (const [table, parquetPath] of tableToSnapshot) {
      const escapedPath = parquetPath.replace(/'/g, "''");
      await connection.run(`CREATE VIEW ${quoteIdent(table)} AS SELECT * FROM read_parquet('${escapedPath}')`);
    }

    const reader = await connection.runAndReadAll(sql);
    const columns = reader.columnNames();
    const rawRows = reader.getRows() as unknown[][];
    // DuckDB returns bigint (BIGINT/HUGEINT), DuckDBDecimalValue (DECIMAL), and
    // other wrappers that JSON.stringify (NextResponse.json) rejects — normalize
    // once here via the shared rule rather than at every consumer.
    const rows = rawRows.map((row) => row.map(normalizeDuckDbValue));
    return { columns, rows, rowCount: rows.length };
  } finally {
    connection.closeSync();
  }
}
