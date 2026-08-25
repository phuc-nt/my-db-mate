/**
 * Differential execution: the rewritten statement must give the SAME answer as
 * the same query written by hand with the definition inlined as a subquery.
 *
 * The unit tests assert on the shape of the rewritten string, which proves the
 * rewrite is what we intended but not that it MEANS the same thing. A view is
 * only trustworthy if `FROM monthly_revenue` and the equivalent subquery return
 * identical rows, so this runs both against the real fixture database and
 * compares. The predicate deliberately selects real rows — an empty result set
 * would match on both sides no matter how wrong the rewrite was.
 */
import { describe, expect, it, afterAll } from 'vitest';
import Database from 'better-sqlite3';
import { resolve } from 'node:path';
import { expandVirtualViews } from '@/core/lib/sql-view-expand';

const db = new Database(resolve(process.cwd(), '.testdata/scope-governance.sqlite'), { readonly: true });
afterAll(() => db.close());

const VIEW = {
  name: 'monthly_revenue',
  sql: "SELECT region, ROUND(SUM(revenue),2) AS revenue FROM mart_orders WHERE status = 'P' GROUP BY region",
};

/** The same query with the view name textually replaced by its definition. */
const inlineByHand = (sql: string) => sql.replace(/\bmonthly_revenue\b/g, `(${VIEW.sql})`);

const cases: [string, string][] = [
  ['a bare select over the view', 'SELECT * FROM monthly_revenue ORDER BY region'],
  ['an aggregate over the view', 'SELECT ROUND(SUM(revenue),2) AS total FROM monthly_revenue'],
  ['a join against a real table',
    'SELECT v.region, COUNT(*) AS n FROM monthly_revenue v JOIN mart_orders o ON o.region = v.region GROUP BY v.region ORDER BY v.region'],
  ['a statement that already has its own WITH',
    'WITH mine AS (SELECT 1 AS x) SELECT v.region, mine.x FROM monthly_revenue v, mine ORDER BY v.region'],
  ['a reference from inside a subquery',
    'SELECT region FROM mart_orders WHERE region IN (SELECT region FROM monthly_revenue) GROUP BY region ORDER BY region'],
];

describe('expanded SQL runs and means the same thing', () => {
  it.each(cases)('%s', (_label, sql) => {
    const res = expandVirtualViews(sql, [VIEW], 'sqlite');
    expect(res.status).toBe('expanded');
    if (res.status !== 'expanded') return;

    const got = db.prepare(res.sql).all();
    const want = db.prepare(inlineByHand(sql)).all();

    expect(got).toEqual(want);
    // Guard the guard: a case that returns nothing would pass trivially.
    expect(got.length).toBeGreaterThan(0);
  });
});
