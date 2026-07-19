import { describe, it, expect } from 'vitest';
import { rewriteWithWhereFilter } from './sql-where-filter-rewrite';

const ok = (r: { sql: string } | { error: string }): string => {
  if ('error' in r) throw new Error(`expected sql, got error: ${r.error}`);
  return r.sql;
};

describe('rewriteWithWhereFilter — subquery wrap', () => {
  it('wraps the widget SQL as a derived table filtered on the outer query', () => {
    const s = ok(rewriteWithWhereFilter('SELECT a, SUM(b) FROM t GROUP BY a', 'a', 'Consumer', 'postgres'));
    expect(s).toMatch(/SELECT \* FROM \(/i);
    expect(s).toMatch(/\) AS _cf WHERE/i);
    expect(s).toContain("'Consumer'");
    // The inner GROUP BY is untouched inside the derived table.
    expect(s).toMatch(/GROUP BY a/i);
  });

  it('filters a SELECT ALIAS — the real fix (fails as a top-level WHERE on Postgres)', () => {
    // `month` is an alias of an expression; only a wrap makes it filterable on
    // standard-conforming dialects.
    const s = ok(rewriteWithWhereFilter("SELECT date_trunc('month', ts) AS month, COUNT(*) c FROM t GROUP BY 1", 'month', '2026-01-01', 'postgres'));
    expect(s).toMatch(/\) AS _cf WHERE "month" = '2026-01-01'/i);
  });

  it('preserves positional GROUP BY / ORDER BY / LIMIT inside the wrap', () => {
    const s = ok(rewriteWithWhereFilter('SELECT a, SUM(b) FROM t GROUP BY 1 ORDER BY 1 LIMIT 60', 'a', 'X', 'postgres'));
    expect(s).toMatch(/GROUP BY 1/i);
    expect(s).toMatch(/ORDER BY 1/i);
    expect(s).toMatch(/LIMIT 60/i);
  });

  it('number value → bare numeric literal', () => {
    const s = ok(rewriteWithWhereFilter('SELECT a FROM t', 'a', 2024, 'postgres'));
    expect(s).toMatch(/=\s*2024/);
    expect(s).not.toMatch(/'2024'/);
  });

  it('boolean value → bool literal', () => {
    expect(ok(rewriteWithWhereFilter('SELECT a FROM t', 'flag', true, 'postgres'))).toMatch(/= TRUE/i);
  });

  it("null value → IS NULL (not = 'null')", () => {
    const s = ok(rewriteWithWhereFilter('SELECT a FROM t', 'a', null, 'postgres'));
    expect(s).toMatch(/IS NULL/i);
    expect(s).not.toMatch(/'null'/i);
  });

  it('escapes a quote in the value (no injection)', () => {
    expect(ok(rewriteWithWhereFilter('SELECT a FROM t', 'a', "O'Brien", 'postgres'))).toContain("'O''Brien'");
  });

  it('neutralizes a quote-breakout injection attempt', () => {
    expect(ok(rewriteWithWhereFilter('SELECT a FROM t', 'a', "x' OR '1'='1", 'postgres'))).toContain("'x'' OR ''1''=''1'");
  });

  // MySQL/BigQuery treat `\` as a string escape; a bare `\'` under quote-doubling
  // alone would break out. Re-parse the emitted SQL and assert the injected
  // `OR 1=1` did not become a live operator in the outer WHERE.
  for (const dialect of ['mysql', 'bigquery'] as const) {
    it(`neutralizes a backslash-quote breakout on ${dialect}`, async () => {
      const s = ok(rewriteWithWhereFilter('SELECT a FROM t', 'a', "\\' OR 1=1 -- ", dialect));
      const { default: pkg } = await import('node-sql-parser');
      const db = dialect === 'mysql' ? 'MySQL' : 'BigQuery';
      const reparsed = new pkg.Parser().astify(s, { database: db }) as { where?: { operator?: string } };
      expect(reparsed.where?.operator).toBe('=');
    });
  }

  // Standard-conforming dialects keep a literal backslash unchanged.
  for (const dialect of ['postgres', 'sqlite', 'mssql'] as const) {
    it(`preserves a literal backslash (not doubled) on ${dialect}`, () => {
      const s = ok(rewriteWithWhereFilter('SELECT a FROM t', 'a', 'C:\\path', dialect));
      expect(s).toContain("'C:\\path'");
      expect(s).not.toContain('C:\\\\path');
    });
  }
});

describe('rewriteWithWhereFilter — all dialects wrap + quote correctly', () => {
  for (const dialect of ['postgres', 'sqlite', 'mssql', 'duckdb'] as const) {
    it(`double-quotes the column on ${dialect}`, () => {
      expect(ok(rewriteWithWhereFilter('SELECT a FROM t', 'a', 'X', dialect))).toContain('WHERE "a" =');
    });
  }
  for (const dialect of ['mysql', 'bigquery'] as const) {
    it(`backtick-quotes the column on ${dialect}`, () => {
      expect(ok(rewriteWithWhereFilter('SELECT a FROM t', 'a', 'X', dialect))).toContain('WHERE `a` =');
    });
  }

  it('a CTE widget is now filterable (lives inside the derived table)', () => {
    const s = ok(rewriteWithWhereFilter('WITH c AS (SELECT 1 AS x) SELECT x FROM c', 'x', 1, 'postgres'));
    expect(s).toMatch(/SELECT \* FROM \(WITH c/i);
    expect(s).toMatch(/\) AS _cf WHERE "x" = 1/i);
  });
});

describe('rewriteWithWhereFilter — refusals (degrade, not wrong SQL)', () => {
  it('rejects a UNION (no single column list to wrap)', () => {
    expect('error' in rewriteWithWhereFilter('SELECT a FROM t UNION SELECT a FROM u', 'a', 'X', 'postgres')).toBe(true);
  });
  it('rejects multi-statement', () => {
    expect('error' in rewriteWithWhereFilter('SELECT 1; SELECT 2', 'a', 'X', 'postgres')).toBe(true);
  });
  it('rejects an invalid column name', () => {
    expect('error' in rewriteWithWhereFilter('SELECT a FROM t', 'a; DROP', 'X', 'postgres')).toBe(true);
  });
  it('rejects non-SELECT', () => {
    expect('error' in rewriteWithWhereFilter('UPDATE t SET a=1', 'a', 'X', 'postgres')).toBe(true);
  });
});
