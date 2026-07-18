import { describe, it, expect } from 'vitest';
import { rewriteWithWhereFilter } from './sql-where-filter-rewrite';

const ok = (r: { sql: string } | { error: string }): string => {
  if ('error' in r) throw new Error(`expected sql, got error: ${r.error}`);
  return r.sql;
};

describe('rewriteWithWhereFilter — happy paths', () => {
  it('adds WHERE when none exists (postgres)', () => {
    const s = ok(rewriteWithWhereFilter('SELECT a, SUM(b) FROM t GROUP BY a', 'a', 'Consumer', 'postgres'));
    expect(s).toMatch(/WHERE/i);
    expect(s).toMatch(/'Consumer'/);
    // WHERE precedes GROUP BY → positional refs unaffected
    expect(s.toUpperCase().indexOf('WHERE')).toBeLessThan(s.toUpperCase().indexOf('GROUP BY'));
  });

  it('ANDs onto an existing WHERE', () => {
    const s = ok(rewriteWithWhereFilter("SELECT a FROM t WHERE x > 1 GROUP BY a", 'a', 'X', 'postgres'));
    expect(s).toMatch(/AND/i);
  });

  it('preserves positional GROUP BY / ORDER BY / LIMIT', () => {
    const s = ok(rewriteWithWhereFilter('SELECT a, SUM(b) FROM t GROUP BY 1 ORDER BY 1 LIMIT 60', 'a', 'X', 'postgres'));
    expect(s).toMatch(/GROUP BY 1/i);
    expect(s).toMatch(/ORDER BY 1/i);
    expect(s).toMatch(/LIMIT 60/i);
  });

  it('number value → numeric literal (no quotes)', () => {
    const s = ok(rewriteWithWhereFilter('SELECT a FROM t', 'a', 2024, 'postgres'));
    expect(s).toMatch(/=\s*2024/);
    expect(s).not.toMatch(/'2024'/);
  });

  it('boolean value → bool literal', () => {
    const s = ok(rewriteWithWhereFilter('SELECT a FROM t', 'flag', true, 'postgres'));
    expect(s).toMatch(/TRUE/i);
  });

  it('null value → IS NULL (not = \'null\')', () => {
    const s = ok(rewriteWithWhereFilter('SELECT a FROM t', 'a', null, 'postgres'));
    expect(s).toMatch(/IS NULL/i);
    expect(s).not.toMatch(/'null'/i);
  });

  it("escapes a quote in the value (no injection)", () => {
    const s = ok(rewriteWithWhereFilter('SELECT a FROM t', 'a', "O'Brien", 'postgres'));
    // Must be the doubled-quote form; a bare `'O'Brien'` would break the string.
    expect(s).toContain("'O''Brien'");
  });

  it("neutralizes a quote-breakout injection attempt", () => {
    const evil = "x' OR '1'='1";
    const s = ok(rewriteWithWhereFilter('SELECT a FROM t', 'a', evil, 'postgres'));
    // The whole payload stays one escaped string literal — no stray operator.
    expect(s).toContain("'x'' OR ''1''=''1'");
  });

  // MySQL/BigQuery treat `\` as a string escape, so a bare `\'` payload would
  // break out under quote-doubling alone. Backslashes are doubled there; re-parse
  // the emitted SQL in the SAME dialect and assert the predicate stayed `=`
  // (the injected `OR 1=1` never becomes the top-level WHERE operator).
  for (const dialect of ['mysql', 'bigquery'] as const) {
    it(`neutralizes a backslash-quote breakout on ${dialect}`, async () => {
      const s = ok(rewriteWithWhereFilter('SELECT a FROM t', 'a', "\\' OR 1=1 -- ", dialect));
      const { default: pkg } = await import('node-sql-parser');
      const db = dialect === 'mysql' ? 'MySQL' : 'BigQuery';
      const reparsed = new pkg.Parser().astify(s, { database: db }) as { where?: { operator?: string } };
      expect(reparsed.where?.operator).toBe('=');
    });
  }

  // On standard-conforming dialects (PG/SQLite/MSSQL) `\` is an ordinary char, so
  // a backslash in the value must be preserved verbatim (NOT doubled) — doubling
  // would change which rows match.
  for (const dialect of ['postgres', 'sqlite', 'mssql'] as const) {
    it(`preserves a literal backslash (not doubled) on ${dialect}`, () => {
      const s = ok(rewriteWithWhereFilter('SELECT a FROM t', 'a', 'C:\\path', dialect));
      expect(s).toContain("'C:\\path'");
      expect(s).not.toContain('C:\\\\path');
    });
  }
});

describe('rewriteWithWhereFilter — all dialects', () => {
  for (const dialect of ['postgres', 'mysql', 'sqlite', 'mssql', 'bigquery', 'duckdb']) {
    it(`rewrites for ${dialect}`, () => {
      const s = ok(rewriteWithWhereFilter('SELECT a, SUM(b) FROM t GROUP BY a', 'a', 'X', dialect));
      expect(s).toMatch(/WHERE/i);
    });
  }

  it('BigQuery round-trips a hyphenated cross-project ref', () => {
    const sql = 'SELECT a FROM `proj-id`.`ds`.`tbl` GROUP BY a';
    const s = ok(rewriteWithWhereFilter(sql, 'a', 'X', 'bigquery'));
    expect(s).toMatch(/proj-id/);
    expect(s).toMatch(/WHERE/i);
  });
});

describe('rewriteWithWhereFilter — refusals (degrade, not wrong SQL)', () => {
  it('rejects a CTE', () => {
    const r = rewriteWithWhereFilter('WITH c AS (SELECT 1 x) SELECT x FROM c', 'x', 1, 'postgres');
    expect('error' in r).toBe(true);
  });
  it('rejects a UNION', () => {
    const r = rewriteWithWhereFilter('SELECT a FROM t UNION SELECT a FROM u', 'a', 'X', 'postgres');
    expect('error' in r).toBe(true);
  });
  it('rejects multi-statement', () => {
    const r = rewriteWithWhereFilter('SELECT 1; SELECT 2', 'a', 'X', 'postgres');
    expect('error' in r).toBe(true);
  });
  it('rejects an invalid column name', () => {
    const r = rewriteWithWhereFilter('SELECT a FROM t', 'a; DROP', 'X', 'postgres');
    expect('error' in r).toBe(true);
  });
  it('rejects non-SELECT', () => {
    const r = rewriteWithWhereFilter('UPDATE t SET a=1', 'a', 'X', 'postgres');
    expect('error' in r).toBe(true);
  });
});
