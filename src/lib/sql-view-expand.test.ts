/**
 * The rewrite is the one place in the governed-datamart path that can change
 * what a query MEANS, so these tests care about two things above all: that a
 * statement naming no view comes back untouched, and that anything the rewrite
 * cannot prove correct is refused rather than guessed at.
 */
import { describe, expect, it } from 'vitest';
import { Parser } from 'node-sql-parser';
import { directBaseTables, expandVirtualViews, mentionsIdentifier, type VirtualViewDef } from './sql-view-expand';
import { PARSER_DIALECT } from '@/core/safety/safety-service';

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
    expect(res.sql).toContain('WITH monthly_revenue AS (');
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

  // The CTE name is emitted bare on every dialect. Quoting it is not a style
  // choice: node-sql-parser rejects a quoted CTE *definition* on BigQuery and
  // Postgres, so a quoted name would make the expanded statement unparseable,
  // and the safety layer fails closed — every query touching a governed view
  // would be blocked. This asserts the output is actually parseable, which is
  // the property that matters; asserting the quote characters is what let the
  // unparseable form ship in the first place.
  it.each(['postgres', 'mysql', 'sqlite', 'mssql', 'bigquery'] as const)(
    'emits an expanded statement the safety parser accepts: %s',
    (dialect) => {
      const res = expandVirtualViews('SELECT * FROM monthly_revenue', VIEWS, dialect);
      expect(res.status).toBe('expanded');
      if (res.status !== 'expanded') return;
      expect(res.sql).toContain('monthly_revenue AS (');
      expect(() =>
        new Parser().astify(res.sql, { database: PARSER_DIALECT[dialect] }),
      ).not.toThrow();
    },
  );
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

/**
 * `viewsOnly` on BigQuery, where the parser's output is shaped differently.
 *
 * The BigQuery grammar hangs a `surround` metadata node off every FROM item to
 * record how the name was quoted, and that node carries its own `table` key
 * holding a quote character or an empty string. A reference walk that does not
 * know this collects a phantom base table named '' or '`' — which belongs to no
 * view and no scope, so the guard blocks a query over nothing but governed
 * views. That failure is invisible to a same-name test on another dialect and
 * it locks the agent out of the curated layer entirely, which is why it gets
 * its own block here.
 */
describe('viewsOnly on BigQuery admits the governed views', () => {
  const views: VirtualViewDef[] = [
    { name: 'mart_sales', sql: 'SELECT 1 AS id' },
  ];

  it.each([
    ['bare name', 'SELECT * FROM mart_sales'],
    ['backtick-quoted', 'SELECT * FROM `mart_sales`'],
    ['aggregated', 'SELECT b, SUM(r) AS t FROM mart_sales GROUP BY b ORDER BY t DESC LIMIT 5'],
    ['wrapped in a caller CTE', 'WITH t AS (SELECT * FROM mart_sales) SELECT * FROM t'],
  ])('reports no raw base table: %s', (_label, sql) => {
    expect(directBaseTables(sql, views, 'bigquery')).toEqual([]);
  });

  it.each([
    ['direct raw table', 'SELECT * FROM orders', 'orders'],
    ['backtick-quoted raw', 'SELECT * FROM `orders`', 'orders'],
    ['fully qualified raw', 'SELECT * FROM `proj.ds.orders`', 'proj.ds.orders'],
    ['joined onto a view', 'SELECT * FROM mart_sales m JOIN orders o ON m.id = o.id', 'orders'],
    ['hidden in a subquery', 'SELECT * FROM mart_sales WHERE id IN (SELECT id FROM raw_pii)', 'raw_pii'],
    ['hidden in a CTE body', 'WITH x AS (SELECT * FROM raw_pii) SELECT * FROM x', 'raw_pii'],
    ['hidden in a derived table', 'SELECT * FROM (SELECT ssn FROM raw_pii) t', 'raw_pii'],
    ['hidden in a UNION branch', 'SELECT id FROM mart_sales UNION ALL SELECT id FROM raw_pii', 'raw_pii'],
    ['hidden in a scalar subquery', 'SELECT (SELECT MAX(x) FROM raw_pii) AS m FROM mart_sales', 'raw_pii'],
  ])('still catches the raw table: %s', (_label, sql, expected) => {
    expect(directBaseTables(sql, views, 'bigquery')).toContain(expected);
  });

  // An alias is not a table. Reporting one is fail-closed and so never unsafe,
  // but it names things the reader never wrote and an alias colliding with a
  // view name would read as a view reference.
  it('reports the tables, not the aliases standing in for them', () => {
    const sql =
      'SELECT p.brand FROM `bigquery-public-data.ds.order_items` oi ' +
      'JOIN `bigquery-public-data.ds.products` p ON oi.product_id = p.id';
    const refs = directBaseTables(sql, views, 'bigquery') ?? [];
    expect(refs).not.toContain('p');
    expect(refs).not.toContain('oi');
    expect(refs).toContain('bigquery-public-data.ds.order_items');
    expect(refs).toContain('bigquery-public-data.ds.products');
  });

  it('never reports a quote character or an empty name as a table', () => {
    for (const sql of ['SELECT * FROM `mart_sales`', 'SELECT * FROM `orders`', 'SELECT * FROM orders']) {
      const refs = directBaseTables(sql, views, 'bigquery') ?? [];
      expect(refs).not.toContain('');
      expect(refs).not.toContain('`');
    }
  });
});
