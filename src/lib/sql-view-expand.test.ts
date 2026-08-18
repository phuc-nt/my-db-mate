/**
 * The rewrite is the one place in the governed-datamart path that can change
 * what a query MEANS, so these tests care about two things above all: that a
 * statement naming no view comes back untouched, and that anything the rewrite
 * cannot prove correct is refused rather than guessed at.
 */
import { describe, expect, it } from 'vitest';
import { expandVirtualViews, mentionsIdentifier } from './sql-view-expand';

const REVENUE = {
  name: 'monthly_revenue',
  sql: "SELECT region, SUM(revenue) AS revenue FROM orders WHERE status = 'paid' GROUP BY region",
};
const CUSTOMERS = { name: 'active_customers', sql: 'SELECT * FROM customers WHERE active = 1' };
const VIEWS = [REVENUE, CUSTOMERS];

const expand = (sql: string, opts = {}) => expandVirtualViews(sql, VIEWS, 'sqlite', opts);

describe('mentionsIdentifier', () => {
  it('matches a standalone identifier', () => {
    expect(mentionsIdentifier('SELECT * FROM monthly_revenue', 'monthly_revenue')).toBe(true);
    expect(mentionsIdentifier('select * from MONTHLY_REVENUE m', 'monthly_revenue')).toBe(true);
  });

  it('does not match a longer name that merely contains it', () => {
    expect(mentionsIdentifier('SELECT * FROM monthly_revenue_2024', 'monthly_revenue')).toBe(false);
    expect(mentionsIdentifier('SELECT * FROM last_monthly_revenue', 'monthly_revenue')).toBe(false);
  });

  it('does not match a name qualified by another schema', () => {
    // `analytics.monthly_revenue` is a real table somewhere else, not our view.
    expect(mentionsIdentifier('SELECT * FROM analytics.monthly_revenue', 'monthly_revenue')).toBe(false);
  });
});

describe('statements that touch no view are left exactly as written', () => {
  it('returns the original string byte-identical', () => {
    const sql = '  SELECT  *   FROM orders  WHERE id = 1  ';
    const res = expand(sql);
    expect(res.status).toBe('unchanged');
    expect(res.status === 'unchanged' && res.sql).toBe(sql);
  });

  it('does nothing when there are no views at all', () => {
    const sql = 'SELECT * FROM monthly_revenue';
    const res = expandVirtualViews(sql, [], 'sqlite');
    expect(res.status).toBe('unchanged');
    expect(res.status === 'unchanged' && res.sql).toBe(sql);
  });

  it('ignores a view name that appears only inside a string literal', () => {
    const res = expand("SELECT * FROM orders WHERE note = 'monthly_revenue'");
    expect(res.status).toBe('unchanged');
  });

  it('ignores a table whose name merely starts with a view name', () => {
    const res = expand('SELECT * FROM monthly_revenue_archive');
    expect(res.status).toBe('unchanged');
  });
});

describe('expansion inlines the curated definition', () => {
  it('wraps a bare reference in a CTE', () => {
    const res = expand('SELECT * FROM monthly_revenue');
    expect(res.status).toBe('expanded');
    if (res.status !== 'expanded') return;
    expect(res.expanded).toEqual(['monthly_revenue']);
    expect(res.sql).toContain('WITH "monthly_revenue" AS (');
    expect(res.sql).toContain("status = 'paid'");
    expect(res.sql.trimEnd().endsWith('SELECT * FROM monthly_revenue')).toBe(true);
  });

  it('expands only the views actually referenced', () => {
    const res = expand('SELECT * FROM monthly_revenue');
    expect(res.status === 'expanded' && res.expanded).toEqual(['monthly_revenue']);
    expect(res.status === 'expanded' && res.sql).not.toContain('active = 1');
  });

  it('expands several views in one statement', () => {
    const res = expand('SELECT * FROM monthly_revenue r JOIN active_customers c ON 1=1');
    expect(res.status).toBe('expanded');
    expect(res.status === 'expanded' && res.expanded.sort()).toEqual(['active_customers', 'monthly_revenue']);
  });

  it('reaches a view referenced from a subquery', () => {
    const res = expand('SELECT * FROM orders WHERE region IN (SELECT region FROM monthly_revenue)');
    expect(res.status).toBe('expanded');
  });

  it('merges into an existing WITH clause instead of nesting', () => {
    const res = expand('WITH mine AS (SELECT 1 AS x) SELECT * FROM monthly_revenue, mine');
    expect(res.status).toBe('expanded');
    if (res.status !== 'expanded') return;
    // One flat chain: exactly one WITH keyword in the result.
    expect(res.sql.match(/\bWITH\b/gi)?.length).toBe(1);
    expect(res.sql).toContain('mine AS (SELECT 1 AS x)');
  });

  it('drops a trailing semicolon from the definition so the CTE stays valid', () => {
    const res = expandVirtualViews('SELECT * FROM v', [{ name: 'v', sql: 'SELECT 1 AS x;' }], 'sqlite');
    expect(res.status === 'expanded' && res.sql).toContain('SELECT 1 AS x\n)');
  });

  it('quotes with backticks on BigQuery', () => {
    const res = expandVirtualViews('SELECT * FROM monthly_revenue', VIEWS, 'bigquery');
    expect(res.status === 'expanded' && res.sql).toContain('`monthly_revenue` AS (');
  });
});

describe('a caller CTE of the same name', () => {
  const sql = 'WITH monthly_revenue AS (SELECT 1 AS revenue) SELECT * FROM monthly_revenue';

  it('wins on an ordinary connection, and is not expanded', () => {
    const res = expand(sql);
    // SQL resolves a CTE ahead of any schema object; honouring that is correct,
    // and the scope guard still inspects the CTE body separately.
    expect(res.status).toBe('unchanged');
  });

  it('is rejected under viewsOnly, where the governed name must mean one thing', () => {
    const res = expand(sql, { viewsOnly: true });
    expect(res.status).toBe('blocked');
    expect(res.status === 'blocked' && res.reason).toMatch(/shadow/i);
  });
});

describe('refusal beats a guess', () => {
  it('blocks unparseable SQL that names a view', () => {
    const res = expand('SELECT ?? FROM monthly_revenue WHERE !!!');
    expect(res.status).toBe('blocked');
    expect(res.status === 'blocked' && res.reason).toMatch(/monthly_revenue/);
  });

  it('leaves unparseable SQL alone when no view is involved', () => {
    // Not this layer's job to reject it — the safety validator will.
    const res = expand('SELECT ?? FROM !!!');
    expect(res.status).toBe('unchanged');
  });
});
