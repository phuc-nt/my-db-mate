import { describe, it, expect } from 'vitest';
import { extractScopeRefs } from './sql-scope-refs';

/** Compact form for assertions: `schema.table` (or bare when unqualified). */
const keys = (sql: string, dialect = 'postgres') =>
  (extractScopeRefs(sql, dialect) ?? []).map((r) => (r.schemaName ? `${r.schemaName}.${r.tableName}` : r.tableName)).sort();

describe('extractScopeRefs — bypass shapes that a top-level FROM walk misses', () => {
  // Each of these hides a reference where `extractLineage` cannot see it. If any
  // regress to omitting `secret_t`, the scope guard fails OPEN.
  it('sees a table referenced only inside a WHERE subquery', () => {
    expect(keys('SELECT a FROM t1 WHERE id IN (SELECT id FROM secret_t)')).toEqual(['secret_t', 't1']);
  });

  it('sees a table referenced only inside a CTE body', () => {
    expect(keys('WITH c AS (SELECT * FROM secret_t) SELECT * FROM c')).toEqual(['secret_t']);
  });

  it('sees a table referenced only inside a derived table', () => {
    expect(keys('SELECT * FROM (SELECT * FROM secret_t) x')).toEqual(['secret_t']);
  });

  it('sees a table referenced only in a UNION branch', () => {
    expect(keys('SELECT a FROM t1 UNION SELECT a FROM secret_t')).toEqual(['secret_t', 't1']);
  });

  it('sees a table referenced only in a scalar subquery in the SELECT list', () => {
    expect(keys('SELECT (SELECT max(x) FROM secret_t) AS m FROM t1')).toEqual(['secret_t', 't1']);
  });

  it('sees a table referenced only in an EXCEPT branch', () => {
    expect(keys('SELECT * FROM ds.a EXCEPT DISTINCT SELECT * FROM ds2.b', 'bigquery')).toEqual(['ds.a', 'ds2.b']);
  });

  it('sees tables inside nested CTE bodies while dropping the CTE names', () => {
    const sql = 'WITH a AS (SELECT 1), b AS (SELECT * FROM a JOIN secret_t ON 1=1) SELECT * FROM b';
    expect(keys(sql)).toEqual(['secret_t']);
  });
});

describe('extractScopeRefs — CTE name handling', () => {
  it('drops CTE names so a local alias is not mistaken for a table', () => {
    expect(keys('WITH c AS (SELECT * FROM real_t) SELECT * FROM c')).toEqual(['real_t']);
  });

  it('still reports the real tables when a CTE shadows a real table name', () => {
    // The CTE is named `orders`, but its body reads `secret_t` — dropping the
    // CTE name must not drop what the body actually reads.
    expect(keys('WITH orders AS (SELECT * FROM secret_t) SELECT * FROM orders')).toEqual(['secret_t']);
  });

  it('keeps a schema-qualified name even when a CTE shares its bare name', () => {
    const sql = 'WITH orders AS (SELECT 1) SELECT * FROM sales.orders, orders';
    expect(keys(sql)).toEqual(['sales.orders']);
  });
});

describe('extractScopeRefs — BigQuery qualification forms', () => {
  it('splits a fully backticked three-part ref and drops the project', () => {
    expect(keys('SELECT * FROM `proj.ds.tbl`', 'bigquery')).toEqual(['ds.tbl']);
  });

  it('splits a backticked ref whose project contains a dash', () => {
    expect(keys('SELECT * FROM `my-proj.ds.tbl`', 'bigquery')).toEqual(['ds.tbl']);
  });

  it('handles the per-identifier backtick form where the schema slot holds proj.ds', () => {
    expect(keys('SELECT * FROM `proj`.`ds`.`tbl`', 'bigquery')).toEqual(['ds.tbl']);
  });

  it('handles a backticked two-part ref', () => {
    expect(keys('SELECT * FROM `ds.tbl`', 'bigquery')).toEqual(['ds.tbl']);
  });

  it('handles an unquoted two-part ref', () => {
    expect(keys('SELECT * FROM ds.tbl', 'bigquery')).toEqual(['ds.tbl']);
  });

  it('keeps the dataset for a wildcard table ref', () => {
    expect(keys('SELECT * FROM `ds.events_*`', 'bigquery')).toEqual(['ds.events_*']);
  });

  it('attributes INFORMATION_SCHEMA to its owning dataset', () => {
    const refs = extractScopeRefs('SELECT * FROM ds.INFORMATION_SCHEMA.TABLES', 'bigquery');
    expect(refs).toEqual([{ schemaName: 'ds', tableName: 'INFORMATION_SCHEMA.TABLES' }]);
  });

  it('reports each dataset in a cross-dataset join', () => {
    const sql = 'WITH c AS (SELECT * FROM ds.a) SELECT * FROM c JOIN ds2.b USING(id)';
    expect(keys(sql, 'bigquery')).toEqual(['ds.a', 'ds2.b']);
  });
});

describe('extractScopeRefs — statements that read no base table', () => {
  it('returns an empty list for SELECT 1', () => {
    expect(extractScopeRefs('SELECT 1', 'postgres')).toEqual([]);
  });

  it('returns an empty list for a pure function call', () => {
    expect(extractScopeRefs('SELECT CURRENT_DATE()', 'bigquery')).toEqual([]);
  });
});

describe('extractScopeRefs — fail-closed contract', () => {
  it('returns null (not an empty list) when the SQL cannot be parsed', () => {
    // Callers distinguish these: [] is "reads nothing, trivially in scope",
    // null is "unknown — block".
    expect(extractScopeRefs('SELECT ?? FROM !!!', 'postgres')).toBeNull();
  });

  it('reports the write target of a data-modifying CTE rather than hiding it', () => {
    // The safety layer blocks this separately; scope must not silently pass it.
    const refs = extractScopeRefs('WITH x AS (INSERT INTO t VALUES (1) RETURNING *) SELECT * FROM x', 'postgres');
    expect(refs?.map((r) => r.tableName)).toContain('t');
  });
});

describe('extractScopeRefs — general dialects', () => {
  it('reports both sides of a join', () => {
    expect(keys('SELECT * FROM orders o JOIN customers c ON o.cid=c.id', 'sqlite')).toEqual(['customers', 'orders']);
  });

  it('keeps the schema for a schema-qualified Postgres ref', () => {
    expect(keys('SELECT * FROM public.orders', 'postgres')).toEqual(['public.orders']);
  });

  it('preserves the identifier case as written', () => {
    // Case-insensitive comparison is the matcher's job, not the extractor's.
    expect(keys('SELECT * FROM Public.Orders', 'postgres')).toEqual(['Public.Orders']);
  });

  it('deduplicates repeated references to the same table', () => {
    expect(keys('SELECT * FROM t1 a JOIN t1 b ON a.id=b.id')).toEqual(['t1']);
  });
});
