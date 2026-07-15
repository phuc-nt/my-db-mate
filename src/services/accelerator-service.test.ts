import { describe, expect, it } from 'vitest';
import { planAcceleration, shouldAccelerate } from './accelerator-service';
import type { RiskAssessment } from './risk-scoring-service';

function risk(overrides: Partial<RiskAssessment['estimate']>): RiskAssessment {
  return {
    tier: 'medium',
    score: 50,
    reason: 'test',
    estimate: { estimatedRows: null, hasFullScan: false, tableCount: 1, ...overrides },
  };
}

describe('shouldAccelerate', () => {
  it('is false when the connection has not opted in', () => {
    expect(shouldAccelerate({ accelerateEnabled: false }, risk({ estimatedRows: 1_000_000 }))).toBe(false);
  });

  it('is false when opted in but row estimate is below the threshold', () => {
    expect(shouldAccelerate({ accelerateEnabled: true }, risk({ estimatedRows: 1_000 }))).toBe(false);
  });

  it('is true when opted in and row estimate exceeds MEDIUM_ROWS', () => {
    expect(shouldAccelerate({ accelerateEnabled: true }, risk({ estimatedRows: 200_000 }))).toBe(true);
  });

  it('falls back to hasFullScan when no row estimate is available', () => {
    expect(shouldAccelerate({ accelerateEnabled: true }, risk({ estimatedRows: null, hasFullScan: true }))).toBe(true);
    expect(shouldAccelerate({ accelerateEnabled: true }, risk({ estimatedRows: null, hasFullScan: false }))).toBe(false);
  });
});

describe('planAcceleration', () => {
  it('extracts a single FROM table', () => {
    const result = planAcceleration('SELECT * FROM orders', 'postgres');
    expect(result).toEqual({ tables: ['orders'] });
  });

  it('extracts FROM + JOIN tables, deduplicated', () => {
    const result = planAcceleration(
      'SELECT o.id FROM orders o JOIN customers c ON o.customer_id = c.id JOIN orders o2 ON o2.id = o.id',
      'postgres',
    );
    // o2 re-aliases orders — the underlying table name is still just 'orders',
    // so the extracted set has 2 entries, not 3.
    expect(result).toEqual({ tables: expect.arrayContaining(['orders', 'customers']) });
    expect((result as { tables: string[] }).tables).toHaveLength(2);
  });

  it('extracts schema-qualified table names', () => {
    const result = planAcceleration('SELECT * FROM public.orders', 'postgres');
    expect(result).toEqual({ tables: ['public.orders'] });
  });

  it('allows ANSI-whitelisted aggregate and scalar functions', () => {
    const result = planAcceleration('SELECT COUNT(*), ROUND(AVG(amount), 2) FROM orders GROUP BY 1', 'postgres');
    expect(result).toEqual({ tables: ['orders'] });
  });

  it('rejects a non-whitelisted dialect-specific function', () => {
    const result = planAcceleration("SELECT DATE_TRUNC('day', created_at) FROM orders", 'postgres');
    expect(result).toEqual({ error: expect.stringContaining('whitelist') });
  });

  it('rejects a non-whitelisted function used in WHERE', () => {
    const result = planAcceleration('SELECT * FROM orders WHERE created_at > NOW()', 'postgres');
    expect(result).toEqual({ error: expect.stringContaining('whitelist') });
  });

  it('rejects CTEs explicitly', () => {
    const result = planAcceleration('WITH x AS (SELECT * FROM orders) SELECT * FROM x', 'postgres');
    expect(result).toEqual({ error: expect.stringContaining('CTE') });
  });

  it('rejects multi-statement SQL', () => {
    const result = planAcceleration('SELECT * FROM a; SELECT * FROM b', 'postgres');
    expect('error' in result).toBe(true);
  });

  it('rejects a subquery in FROM', () => {
    const result = planAcceleration('SELECT * FROM (SELECT * FROM orders) t', 'postgres');
    expect('error' in result).toBe(true);
  });

  it('rejects non-SELECT SQL', () => {
    const result = planAcceleration('DELETE FROM orders', 'postgres');
    expect('error' in result).toBe(true);
  });

  it('rejects a quoted table identifier containing a stacked-statement payload', () => {
    // Extracted table names are interpolated into a fresh `SELECT * FROM <table>`
    // string later (query-executor-service.ts) — a non-plain identifier here
    // would inject into that unvalidated string.
    const result = planAcceleration('SELECT * FROM "orders\'; DROP TABLE query_runs; --"', 'postgres');
    expect('error' in result).toBe(true);
    expect((result as { error: string }).error).toContain('unsupported table name');
  });

  it('rejects a quoted table identifier containing a UNION-based exfiltration payload', () => {
    const result = planAcceleration(
      'SELECT * FROM "orders WHERE 1=0 UNION SELECT secretEncrypted FROM connections --"',
      'postgres',
    );
    expect('error' in result).toBe(true);
    expect((result as { error: string }).error).toContain('unsupported table name');
  });

  it('rejects a schema-qualifier that is not a plain identifier', () => {
    const result = planAcceleration('SELECT * FROM "pub\'lic".orders', 'postgres');
    expect('error' in result).toBe(true);
    expect((result as { error: string }).error).toContain('unsupported schema name');
  });
});
