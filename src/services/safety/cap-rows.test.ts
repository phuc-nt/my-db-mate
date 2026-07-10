import { describe, it, expect } from 'vitest';
import { capRows, validateSql } from './safety-service';

describe('capRows dialect-aware row cap', () => {
  it('uses LIMIT for postgres/mysql/sqlite', () => {
    expect(capRows('SELECT 1', 500, 'postgres')).toContain('LIMIT 500');
    expect(capRows('SELECT 1', 500, 'mysql')).toContain('LIMIT 500');
    expect(capRows('SELECT 1', 500, 'sqlite')).toContain('LIMIT 500');
  });

  it('caps mssql with TOP, not LIMIT', () => {
    const out = capRows('SELECT id FROM t', 500, 'mssql');
    expect(out).not.toContain('LIMIT');
    expect(out).toMatch(/TOP \(500\)/i);
  });

  it('caps a plain mssql SELECT with inline TOP after the SELECT keyword', () => {
    const out = capRows('SELECT id FROM t', 500, 'mssql');
    expect(out).toMatch(/^SELECT TOP \(500\) id FROM t/i);
    expect(out).not.toContain('ORDER BY (SELECT NULL)');
  });

  it('is UNION-safe (wraps the whole set as a derived table)', () => {
    const out = capRows('SELECT id FROM a UNION SELECT id FROM b', 500, 'mssql');
    expect(out).toMatch(/SELECT TOP \(500\) \* FROM \(/i);
  });

  it('caps an unnamed aggregate column without a derived-table error', () => {
    // COUNT(*) has no name; the inline-TOP form (not a wrap) keeps it valid.
    const out = capRows('SELECT c, COUNT(*) FROM t GROUP BY c', 500, 'mssql');
    expect(out).toMatch(/^SELECT TOP \(500\) c, COUNT/i);
  });

  it('is subquery-ORDER-BY-safe (inline TOP, no broken outer FETCH)', () => {
    const out = capRows('SELECT * FROM (SELECT id FROM t ORDER BY id OFFSET 0 ROWS FETCH NEXT 5 ROWS ONLY) s', 500, 'mssql');
    expect(out).toMatch(/^SELECT TOP \(500\) \* FROM \(/i);
    expect(out).not.toContain('ORDER BY (SELECT NULL)');
    expect(out).not.toMatch(/FETCH NEXT 500/i);
  });
});

describe('validateSql row-cap injection per dialect', () => {
  it('caps an uncapped mssql SELECT with inline TOP (not LIMIT)', () => {
    const v = validateSql('SELECT id, name FROM users', 'mssql');
    expect(v.status).toBe('ok');
    if (v.status === 'ok') {
      expect(v.sql).toMatch(/^SELECT TOP \(500\) id, name/i);
      expect(v.sql).not.toContain('LIMIT');
    }
  });

  it('does not double-cap an mssql query that already uses TOP', () => {
    const v = validateSql('SELECT TOP 10 * FROM users', 'mssql');
    expect(v.status).toBe('ok');
    if (v.status === 'ok') expect(v.sql).not.toContain('FETCH NEXT');
  });

  it('still injects LIMIT for postgres', () => {
    const v = validateSql('SELECT id FROM users', 'postgres');
    expect(v.status).toBe('ok');
    if (v.status === 'ok') expect(v.sql).toContain('LIMIT 500');
  });
});
