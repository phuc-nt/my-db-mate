import { describe, it, expect } from 'vitest';
import { analyzeQueries, parametrizeLiterals, parsePastedLog } from './query-history-mining-service';

const rows = (...sqls: string[]) => sqls.map((sql) => ({ sql, count: 1 }));

describe('parametrizeLiterals — privacy', () => {
  it('replaces string + number literals with ?', () => {
    expect(parametrizeLiterals("SELECT * FROM t WHERE email = 'x@y.com' AND age = 42"))
      .toBe('SELECT * FROM t WHERE email = ? AND age = ?');
  });
  it('leaves quoted identifiers intact', () => {
    expect(parametrizeLiterals('SELECT "id", "full name" FROM "my table"'))
      .toBe('SELECT "id", "full name" FROM "my table"');
  });
  it('handles doubled-quote escapes inside a literal', () => {
    expect(parametrizeLiterals("SELECT * FROM t WHERE s = 'O''Brien'"))
      .toBe('SELECT * FROM t WHERE s = ?');
  });
  it('handles backslash-escaped quotes (MySQL default) without leaking fragments', () => {
    expect(parametrizeLiterals("SELECT * FROM t WHERE s = 'O\\'Brien' AND x = 1"))
      .toBe('SELECT * FROM t WHERE s = ? AND x = ?');
  });
  it('strips dollar-quoted string literals (Postgres) — no PII leak', () => {
    expect(parametrizeLiterals('SELECT id FROM notes WHERE body = $$my SSN is 123-45-6789$$ AND owner_id = 7'))
      .toBe('SELECT id FROM notes WHERE body = ? AND owner_id = ?');
    expect(parametrizeLiterals("SELECT * FROM t WHERE x = $tag$a;b$tag$"))
      .toBe('SELECT * FROM t WHERE x = ?');
  });
  it('strips a string-prefix literal without leaking the body', () => {
    expect(parametrizeLiterals("SELECT * FROM t WHERE s = E'secret\\n'"))
      .toBe('SELECT * FROM t WHERE s = ?');
  });
  it('does not parametrize identifiers that contain digits', () => {
    expect(parametrizeLiterals('SELECT col2, t1.x FROM t1 WHERE col2 > 5'))
      .toBe('SELECT col2, t1.x FROM t1 WHERE col2 > ?');
  });
});

describe('analyzeQueries — filtering', () => {
  it('drops trivial queries (SELECT 1, single-table no filter)', () => {
    const out = analyzeQueries(rows('SELECT 1', 'SELECT * FROM users'), 'postgres');
    expect(out).toHaveLength(0);
  });
  it('drops catalog/information_schema queries', () => {
    const out = analyzeQueries(rows("SELECT table_name FROM information_schema.tables WHERE table_schema='public'"), 'postgres');
    expect(out).toHaveLength(0);
  });
  it('keeps a filtered / grouped / joined query', () => {
    const out = analyzeQueries(rows(
      'SELECT status, COUNT(*) FROM orders GROUP BY status',
      "SELECT * FROM users WHERE id = 5",
    ), 'postgres');
    expect(out.length).toBe(2);
    expect(out.every((q) => !/= 5\b/.test(q.normalizedSql))).toBe(true); // parametrized
  });
  it('parse failure on one query does not break the batch', () => {
    const out = analyzeQueries(rows('THIS IS NOT SQL ;;;', 'SELECT a, b FROM t WHERE a > 1'), 'postgres');
    expect(out).toHaveLength(1);
  });
  it('ranks a multi-table join above a single-table filter', () => {
    const out = analyzeQueries(rows(
      'SELECT x FROM a WHERE x > 1',
      'SELECT a.x FROM a JOIN b ON a.b_id = b.id JOIN c ON c.a_id = a.id',
    ), 'postgres');
    expect(out[0].joinEdges.length).toBeGreaterThan(0);
    expect(out[0].tables.length).toBeGreaterThan(1);
  });
});

describe('parsePastedLog', () => {
  it('splits statements on ; but not inside string literals', () => {
    const out = parsePastedLog("SELECT * FROM t WHERE s = 'a;b'; SELECT 1;");
    expect(out).toHaveLength(2);
    expect(out[0].sql).toContain("'a;b'");
  });
  it('strips slow-query-log noise lines', () => {
    const log = `# Time: 2026-01-01T00:00:00\n# Query_time: 1.5\nSET timestamp=123;\nSELECT id FROM users WHERE x = 1;`;
    const out = parsePastedLog(log);
    expect(out).toHaveLength(1);
    expect(out[0].sql).toMatch(/SELECT id FROM users/);
  });
  it('caps the number of statements', () => {
    const many = Array.from({ length: 50 }, (_, i) => `SELECT ${i};`).join('\n');
    expect(parsePastedLog(many, 10)).toHaveLength(10);
  });
});

describe('analyzeQueries — JOIN edge extraction (false-relationship guards)', () => {
  it('extracts a clean FK-like equi-join', () => {
    const out = analyzeQueries(rows('SELECT o.id FROM orders o JOIN users u ON o.user_id = u.id'), 'postgres');
    expect(out[0].joinEdges).toContainEqual({ fromTable: 'orders', fromColumn: 'user_id', toTable: 'users', toColumn: 'id' });
  });
  it('drops same-column-name joins (shared enum / partition key)', () => {
    const out = analyzeQueries(rows('SELECT * FROM a JOIN b ON a.status = b.status WHERE a.x > 1'), 'postgres');
    expect(out[0]?.joinEdges ?? []).toHaveLength(0);
  });
  it('drops self-joins', () => {
    const out = analyzeQueries(rows('SELECT * FROM emp e JOIN emp m ON e.manager_id = m.id WHERE e.x > 1'), 'postgres');
    expect(out[0]?.joinEdges ?? []).toHaveLength(0);
  });
  it('drops non-key equi-joins', () => {
    const out = analyzeQueries(rows('SELECT * FROM a JOIN b ON a.created = b.reported WHERE a.x > 1'), 'postgres');
    expect(out[0]?.joinEdges ?? []).toHaveLength(0);
  });
});
