import { describe, it, expect } from 'vitest';
import { normalizeResultForVote, tallyVote, hasTotalOrderBy, VOTE_LIMIT } from './candidate-sql-service';
import type { CandidateRun } from '../lib/candidate-vote-types';

const sig = (cols: string[], rows: unknown[][]) => normalizeResultForVote(cols, rows);

describe('normalizeResultForVote — canonical result signature (red-team C3)', () => {
  it('is order-independent across columns of the same name-set', () => {
    // Same data, columns projected in different order → same signature.
    const a = sig(['month', 'revenue'], [['2026-01', 100], ['2026-02', 200]]);
    const b = sig(['revenue', 'month'], [[100, '2026-01'], [200, '2026-02']]);
    expect(a).toBe(b);
  });

  it('is order-independent across rows (no ORDER BY)', () => {
    const a = sig(['seg', 'n'], [['A', 1], ['B', 2], ['C', 3]]);
    const b = sig(['seg', 'n'], [['C', 3], ['A', 1], ['B', 2]]);
    expect(a).toBe(b);
  });

  it('treats a different column name-set as a diverge signal', () => {
    // count(*) vs count(id) alias differently → different shape → different sig.
    const a = sig(['count'], [[42]]);
    const b = sig(['cnt'], [[42]]);
    expect(a).not.toBe(b);
  });

  it('treats a column superset as diverge (extra debug column)', () => {
    const a = sig(['total'], [[100]]);
    const b = sig(['total', 'debug'], [[100, 'x']]);
    expect(a).not.toBe(b);
  });

  it('collapses numeric string vs number (driver shape difference)', () => {
    // pg NUMERIC often arrives as a string; must compare equal to the number.
    const a = sig(['revenue'], [['1234.5']]);
    const b = sig(['revenue'], [[1234.5]]);
    expect(a).toBe(b);
  });

  it('distinguishes NULL from 0 and from empty string', () => {
    const nul = sig(['x'], [[null]]);
    const zero = sig(['x'], [[0]]);
    const empty = sig(['x'], [['']]);
    expect(nul).not.toBe(zero);
    expect(nul).not.toBe(empty);
    expect(zero).not.toBe(empty);
  });

  it('collapses tiny float-formatting differences (relative epsilon)', () => {
    const a = sig(['avg'], [[1234.5678901234]]);
    const b = sig(['avg'], [[1234.5678901235]]); // differs ~1e-10
    expect(a).toBe(b);
  });

  it('distinguishes genuinely different magnitudes', () => {
    const a = sig(['avg'], [[1234.5]]);
    const b = sig(['avg'], [[1234.6]]);
    expect(a).not.toBe(b);
  });

  it('normalizes Date and ISO-string dates to the same value', () => {
    const d = new Date('2026-01-15T00:00:00.000Z');
    const a = sig(['day'], [[d]]);
    const b = sig(['day'], [['2026-01-15T00:00:00.000Z']]);
    // An ISO-string date and a Date object canonicalize to the same bucket, so a
    // column returned as string by one driver and Date by another does not diverge.
    expect(a).toBe(b);
  });

  it('distinguishes empty result from a single row of nulls', () => {
    const empty = sig(['x'], []);
    const oneNull = sig(['x'], [[null]]);
    expect(empty).not.toBe(oneNull);
  });

  it('only compares the first VOTE_LIMIT rows', () => {
    const many = (n: number, tail: number) =>
      Array.from({ length: n }, (_, i) => [i < VOTE_LIMIT ? i : tail]);
    // First VOTE_LIMIT rows identical; rows beyond the window differ → same sig.
    // Build deterministic ordered rows so the sort keeps the window stable.
    const rowsA = Array.from({ length: VOTE_LIMIT + 10 }, (_, i) => [i]);
    const rowsB = [...rowsA];
    rowsB[VOTE_LIMIT + 5] = [99999]; // change a row beyond the window
    expect(sig(['n'], rowsA)).toBe(sig(['n'], rowsB));
    void many;
  });
});

describe('hasTotalOrderBy', () => {
  it('detects a top-level ORDER BY', () => {
    expect(hasTotalOrderBy('SELECT a FROM t ORDER BY a')).toBe(true);
    expect(hasTotalOrderBy('select * from t order by 1 desc')).toBe(true);
  });
  it('is false when there is no ORDER BY', () => {
    expect(hasTotalOrderBy('SELECT a FROM t WHERE a > 1')).toBe(false);
  });
  it('ignores ORDER BY inside a string literal', () => {
    expect(hasTotalOrderBy("SELECT a FROM t WHERE note = 'order by hack'")).toBe(false);
  });
});

const run = (over: Partial<CandidateRun>): CandidateRun => ({
  sql: 'SELECT 1', isBase: false, signature: 'sig-x', columns: ['x'], rowsPreview: [[1]], ...over,
});

describe('tallyVote', () => {
  it('consensus when all executed candidates share a signature', () => {
    const v = tallyVote([
      run({ isBase: true, signature: 'A' }),
      run({ signature: 'A' }),
      run({ signature: 'A' }),
    ]);
    expect(v).toEqual({ kind: 'consensus', agree: 3, total: 3 });
  });

  it('diverge when signatures differ, base SQL represents its group', () => {
    const v = tallyVote([
      run({ isBase: true, signature: 'A', sql: 'BASE' }),
      run({ signature: 'B', sql: 'ALT' }),
    ]);
    expect(v.kind).toBe('diverge');
    if (v.kind === 'diverge') {
      expect(v.groups).toHaveLength(2);
      const baseGroup = v.groups.find((g) => g.sql === 'BASE');
      expect(baseGroup?.count).toBe(1);
    }
  });

  it('inconclusive when fewer than 2 candidates executed', () => {
    const v = tallyVote([
      run({ isBase: true, signature: 'A' }),
      run({ signature: null, excludedReason: 'high-risk' }),
    ]);
    expect(v.kind).toBe('inconclusive');
  });

  it('inconclusive when the result is large + unordered (H4), even if signatures match', () => {
    const v = tallyVote(
      [run({ isBase: true, signature: 'A' }), run({ signature: 'A' })],
      { bigUnordered: true },
    );
    expect(v.kind).toBe('inconclusive');
  });

  it('groups multiple agreeing candidates within a diverge', () => {
    const v = tallyVote([
      run({ isBase: true, signature: 'A' }),
      run({ signature: 'A' }),
      run({ signature: 'B' }),
    ]);
    expect(v.kind).toBe('diverge');
    if (v.kind === 'diverge') {
      const majority = v.groups.find((g) => g.count === 2);
      expect(majority).toBeTruthy();
    }
  });
});
