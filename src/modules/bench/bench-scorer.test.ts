import { describe, it, expect } from 'vitest';
import { executionMatch, resultSetHash, extractFinalSql, tallyVerdicts, VERDICTS } from './bench-scorer';

describe('executionMatch — BIRD set semantics', () => {
  it('matches identical results', () => {
    expect(executionMatch([[1, 'a'], [2, 'b']], [[1, 'a'], [2, 'b']])).toBe(true);
  });

  it('scores a single perturbed cell as wrong', () => {
    // The mutation check for this whole file: if the hash ever stops depending
    // on the values, everything else here still passes and this does not.
    expect(executionMatch([[1, 'a'], [2, 'b']], [[1, 'a'], [2, 'c']])).toBe(false);
  });

  it('ignores row order, as BIRD does', () => {
    expect(executionMatch([[2, 'b'], [1, 'a']], [[1, 'a'], [2, 'b']])).toBe(true);
  });

  it('ignores duplicate rows, as BIRD set() does', () => {
    // A prediction missing DISTINCT still scores 1 on the leaderboard. Scoring
    // it wrong would make our EX lower than the same answer earns publicly.
    expect(executionMatch([[1], [1], [1]], [[1]])).toBe(true);
  });

  it('does NOT ignore column order within a row', () => {
    expect(executionMatch([[1, 2]], [[2, 1]])).toBe(false);
  });

  it('separates NULL from the string "NULL"', () => {
    expect(executionMatch([[null]], [['NULL']])).toBe(false);
  });

  it('separates a number from its string form', () => {
    expect(executionMatch([[1]], [['1']])).toBe(false);
  });

  it('separates a boolean from its string form', () => {
    // Numbers get their own tag branch, so only booleans and strings reach the
    // fallback — this is the one case where that branch's tag is load-bearing.
    expect(executionMatch([[true]], [['true']])).toBe(false);
  });

  it('treats an integral float as its integer', () => {
    // SQLite returns 5 from COUNT(*) and 5.0 from some aggregate paths; no BIRD
    // question distinguishes them, so a right answer must not fail on it.
    expect(executionMatch([[5.0]], [[5]])).toBe(true);
  });

  it('keeps a genuine fractional difference', () => {
    expect(executionMatch([[5.5]], [[5.4]])).toBe(false);
  });

  it('scores an empty result against a non-empty one as wrong', () => {
    expect(executionMatch([], [[1]])).toBe(false);
  });

  it('matches two empty results', () => {
    expect(executionMatch([], [])).toBe(true);
  });

  it('does not let cell boundaries blur into each other', () => {
    // The type tag alone is NOT enough: a value that itself contains a tag
    // prefix reconstructs its neighbour's text. Without a separator,
    // ['a', 'b'] and ['astring:b'] both render "string:astring:b", so a
    // two-column answer would match a one-column one.
    expect(resultSetHash([['a', 'b']])).not.toBe(resultSetHash([['astring:b']]));
  });

  it('does not let row boundaries blur into each other', () => {
    // Same failure one level up: two one-row results must not concatenate into
    // the same text as one result holding both rows.
    expect(resultSetHash([['a'], ['b']])).not.toBe(resultSetHash([['a\u0002string:b']]));
  });
});

describe('extractFinalSql', () => {
  it('takes the LAST fenced SQL block, not the first', () => {
    const text = 'First I checked:\n```sql\nSELECT DISTINCT status FROM orders\n```\nThen the answer:\n```sql\nSELECT COUNT(*) FROM orders\n```';
    expect(extractFinalSql(text)).toBe('SELECT COUNT(*) FROM orders');
  });

  it('accepts an unlabelled fence that holds SQL', () => {
    expect(extractFinalSql('```\nSELECT 1\n```')).toBe('SELECT 1');
  });

  it('accepts a CTE', () => {
    expect(extractFinalSql('```sql\nWITH x AS (SELECT 1) SELECT * FROM x\n```')).toBe('WITH x AS (SELECT 1) SELECT * FROM x');
  });

  it('ignores a fenced block that is not SQL', () => {
    // A results table or a JSON payload in a fence is not the query.
    expect(extractFinalSql('```json\n{"rows": 3}\n```')).toBeNull();
  });

  it('skips a trailing non-SQL fence and keeps the real query', () => {
    // The agent usually shows its SQL and THEN the result table. Taking the
    // last fence unconditionally would score the result table as the query.
    const text = '```sql\nSELECT COUNT(*) FROM orders\n```\nResult:\n```\ncount\n2845\n```';
    expect(extractFinalSql(text)).toBe('SELECT COUNT(*) FROM orders');
  });

  it('returns null for prose containing the word select', () => {
    // Guessing which sentence was the query would measure the guess.
    expect(extractFinalSql('I would select the count of orders from the table.')).toBeNull();
  });

  it('strips a trailing semicolon so it round-trips into the executor', () => {
    expect(extractFinalSql('```sql\nSELECT 1;\n```')).toBe('SELECT 1');
  });
});

describe('tallyVerdicts', () => {
  it('reports every verdict, including ones that did not occur', () => {
    const t = tallyVerdicts(['correct', 'correct', 'no_sql']);
    expect(t.correct).toBe(2);
    expect(t.no_sql).toBe(1);
    expect(t.gate_blocked).toBe(0);
    expect(Object.keys(t).sort()).toEqual([...VERDICTS].sort());
  });

  it('counts a step-capped answer apart from a prose answer', () => {
    // Both produced no SQL, but one ran out of steps and one did not. A tally
    // that folded them together would report a single "no SQL" figure that no
    // single fix addresses.
    const t = tallyVerdicts(['no_sql', 'step_cap', 'step_cap']);
    expect(t.no_sql).toBe(1);
    expect(t.step_cap).toBe(2);
  });
});
