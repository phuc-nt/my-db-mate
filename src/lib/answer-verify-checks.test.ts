import { describe, it, expect } from 'vitest';
import { runAnswerChecks, type AnswerCheckInput } from './answer-verify-checks';

const base: Omit<AnswerCheckInput, 'sql' | 'columns' | 'rows'> = {
  metric: null, enforcedLimit: 500, limitInjected: false,
};
const find = (r: ReturnType<typeof runAnswerChecks>, id: string) => r.checks.find((c) => c.id === id)!;

describe('row-cap', () => {
  it('warns when the injected cap is hit', () => {
    const rows = Array.from({ length: 500 }, (_, i) => [i]);
    const r = runAnswerChecks({ ...base, sql: 'SELECT a FROM t', columns: ['a'], rows, limitInjected: true });
    expect(find(r, 'row-cap').status).toBe('warn');
  });
  it('passes when the user wrote a smaller LIMIT that was reached (not injected)', () => {
    const rows = Array.from({ length: 500 }, (_, i) => [i]);
    const r = runAnswerChecks({ ...base, sql: 'SELECT a FROM t LIMIT 500', columns: ['a'], rows, limitInjected: false });
    expect(find(r, 'row-cap').status).toBe('pass');
  });
});

describe('metric-magnitude', () => {
  const metric = { lastRun: { latest: 70000, prev: 200000, deltaPct: null, latestT: '2026-07' }, timeGrain: 'month' };
  it('skips without a metric', () => {
    const r = runAnswerChecks({ ...base, sql: 'SELECT SUM(x) FROM t', columns: ['s'], rows: [[190000]] });
    expect(find(r, 'metric-magnitude').status).toBe('skip');
  });
  it('scalar within 100x compares against max(latest,prev) → pass (uses prev not partial latest)', () => {
    // 190K vs max(70K,200K)=200K → ~1x → pass, even though latest is a mid-month 70K
    const r = runAnswerChecks({ ...base, metric, sql: 'SELECT SUM(x) FROM t', columns: ['s'], rows: [[190000]] });
    expect(find(r, 'metric-magnitude').status).toBe('pass');
  });
  it('scalar >100x → warn', () => {
    const r = runAnswerChecks({ ...base, metric, sql: 'SELECT SUM(x) FROM t', columns: ['s'], rows: [[25_000_000]] });
    expect(find(r, 'metric-magnitude').status).toBe('warn');
  });
  it('yearly total ~12x a monthly metric does NOT warn (scalar 100x gate)', () => {
    const r = runAnswerChecks({ ...base, metric, sql: 'SELECT SUM(x) FROM t', columns: ['s'], rows: [[2_400_000]] });
    expect(find(r, 'metric-magnitude').status).toBe('pass');
  });
  it('same-grain (monthly) breakdown 10x off → warn', () => {
    const r = runAnswerChecks({ ...base, metric, sql: 'SELECT month, SUM(x) FROM t GROUP BY 1', columns: ['month', 's'], rows: [['2026-06', 2_500_000], ['2026-07', 3_000_000]] });
    expect(find(r, 'metric-magnitude').status).toBe('warn');
  });
});

describe('date-coverage', () => {
  it('warns when result covers <60% of the asked range', () => {
    const r = runAnswerChecks({ ...base, sql: "SELECT month, x FROM t WHERE d BETWEEN '2026-01-01' AND '2026-12-31' GROUP BY 1", columns: ['month', 'x'], rows: [['2026-01', 1], ['2026-02', 2]] });
    expect(find(r, 'date-coverage').status).toBe('warn');
  });
  it('passes when coverage is full', () => {
    const r = runAnswerChecks({ ...base, sql: "SELECT month, x FROM t WHERE d BETWEEN '2026-01-01' AND '2026-03-31' GROUP BY 1", columns: ['month', 'x'], rows: [['2026-01', 1], ['2026-03', 2]] });
    expect(find(r, 'date-coverage').status).toBe('pass');
  });
  it('skips without a date range in SQL', () => {
    const r = runAnswerChecks({ ...base, sql: 'SELECT month, x FROM t GROUP BY 1', columns: ['month', 'x'], rows: [['2026-01', 1]] });
    expect(find(r, 'date-coverage').status).toBe('skip');
  });
});

describe('duplicate-rows', () => {
  it('warns on duplicates when SQL has a JOIN', () => {
    const r = runAnswerChecks({ ...base, sql: 'SELECT a.x, b.y FROM a JOIN b ON a.id=b.id', columns: ['x', 'y'], rows: [[1, 2], [1, 2], [3, 4]] });
    expect(find(r, 'duplicate-rows').status).toBe('warn');
  });
  it('skips duplicates without a JOIN (projection repeats are normal)', () => {
    const r = runAnswerChecks({ ...base, sql: 'SELECT status FROM orders', columns: ['status'], rows: [['C'], ['C'], ['D']] });
    expect(find(r, 'duplicate-rows').status).toBe('skip');
  });
  it('BigInt row values do not throw', () => {
    const r = runAnswerChecks({ ...base, sql: 'SELECT a.x FROM a JOIN b ON a.id=b.id', columns: ['x'], rows: [[1n], [1n]] });
    expect(find(r, 'duplicate-rows').status).toBe('warn');
  });
});

describe('truncated result skips whole-row checks', () => {
  it('date-coverage and duplicate-rows skip when truncated', () => {
    const rows = Array.from({ length: 500 }, (_, i) => [`2026-01`, i]);
    const r = runAnswerChecks({ ...base, sql: "SELECT month, x FROM a JOIN b ON a.id=b.id WHERE d BETWEEN '2026-01-01' AND '2026-12-31'", columns: ['month', 'x'], rows, limitInjected: true });
    expect(find(r, 'date-coverage').status).toBe('skip');
    expect(find(r, 'duplicate-rows').status).toBe('skip');
    expect(find(r, 'row-cap').status).toBe('warn');
  });
});
