import { describe, expect, it } from 'vitest';
import { rewriteWithDimension } from './sql-dimension-rewrite';

const METRIC_SQL = "SELECT strftime('%Y-%m', order_date) AS month, SUM(total_amt) AS revenue FROM orders GROUP BY 1 ORDER BY 1";

describe('rewriteWithDimension', () => {
  it('appends the dimension to SELECT and GROUP BY (sqlite)', () => {
    const r = rewriteWithDimension(METRIC_SQL, 'ord_sts_cd', 'sqlite');
    expect('sql' in r).toBe(true);
    if ('sql' in r) {
      expect(r.sql).toMatch(/SELECT strftime.*SUM.*"ord_sts_cd"/i);
      expect(r.sql).toMatch(/GROUP BY 1, "ord_sts_cd"/i);
      expect(r.sql).toMatch(/LIMIT 10000$/);
      expect(r.cap).toBe(10000);
    }
  });

  it('keeps positional GROUP BY meaning (dim appended, not inserted)', () => {
    const r = rewriteWithDimension('SELECT d, COUNT(*) FROM t GROUP BY 1 ORDER BY 1', 'seg', 'postgres');
    if ('sql' in r) {
      // Position 1 must still be the first ORIGINAL column; dim comes after.
      expect(r.sql.indexOf('"seg"') > r.sql.indexOf('COUNT')).toBe(true);
      expect(r.sql).toMatch(/GROUP BY 1, "seg"/);
    } else {
      throw new Error(r.error);
    }
  });

  it('rejects dirty dimension names (injection via identifier)', () => {
    for (const bad of ['a; DROP TABLE x', 'a b', 'a-b', '1col', 'col"', "col'"]) {
      const r = rewriteWithDimension(METRIC_SQL, bad, 'sqlite');
      expect('error' in r).toBe(true);
    }
  });

  it('rejects CTEs explicitly even though they parse as select', () => {
    const r = rewriteWithDimension('WITH x AS (SELECT 1 AS a) SELECT a, COUNT(*) FROM x GROUP BY 1', 'a', 'postgres');
    expect(r).toEqual({ error: expect.stringContaining('CTE') });
  });

  it('rejects SQL without GROUP BY', () => {
    const r = rewriteWithDimension('SELECT created_at, amount FROM payments', 'region', 'postgres');
    expect(r).toEqual({ error: expect.stringContaining('GROUP BY') });
  });

  it('rejects multi-statement SQL', () => {
    const r = rewriteWithDimension('SELECT a, COUNT(*) FROM t GROUP BY 1; SELECT 2', 'a', 'mysql');
    expect('error' in r).toBe(true);
  });

  it('mssql: no LIMIT appended, cap drops to the injected TOP 500', () => {
    const r = rewriteWithDimension('SELECT d, COUNT(*) AS n FROM t GROUP BY d', 'seg', 'mssql');
    if ('sql' in r) {
      expect(r.sql).not.toMatch(/LIMIT/i);
      expect(r.cap).toBe(500);
    } else {
      throw new Error(r.error);
    }
  });

  it('postgres output parses back (round-trip sanity)', () => {
    const r = rewriteWithDimension("SELECT date_trunc('month', ts) AS m, SUM(v) FROM ev GROUP BY 1", 'kind', 'postgres');
    expect('sql' in r).toBe(true);
    if ('sql' in r) expect(r.sql).toMatch(/GROUP BY 1, "kind" LIMIT 10000$/);
  });
});
