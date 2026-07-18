/**
 * Cross-filter request validation — tests the REAL parseCrossFilters guard used
 * by the widget refresh route. It must reject bad column names, non-primitive
 * values, and over-long lists before anything reaches the AST rewrite.
 */
import { describe, it, expect } from 'vitest';
import { parseCrossFilters } from './[id]/widgets/[widgetId]/route';

const ok = (r: ReturnType<typeof parseCrossFilters>) => !('error' in r);

describe('parseCrossFilters', () => {
  it('accepts a valid single filter', () => {
    const r = parseCrossFilters([{ column: 'segment', value: 'Consumer' }]);
    expect(ok(r)).toBe(true);
    if (!('error' in r)) expect(r.filters).toEqual([{ column: 'segment', value: 'Consumer' }]);
  });
  it('accepts null / number / boolean values', () => {
    expect(ok(parseCrossFilters([{ column: 'a', value: null }, { column: 'b', value: 2 }, { column: 'c', value: true }]))).toBe(true);
  });
  it('accepts an absent / empty filter set', () => {
    expect(ok(parseCrossFilters(undefined))).toBe(true);
    expect(ok(parseCrossFilters([]))).toBe(true);
  });
  it('rejects a non-identifier column (injection guard)', () => {
    expect(ok(parseCrossFilters([{ column: "a'; DROP TABLE t;--", value: 1 }]))).toBe(false);
  });
  it('rejects an object value', () => {
    expect(ok(parseCrossFilters([{ column: 'a', value: { nested: 1 } }]))).toBe(false);
  });
  it('rejects more than 3 filters', () => {
    expect(ok(parseCrossFilters([1, 2, 3, 4].map((n) => ({ column: `c${n}`, value: n }))))).toBe(false);
  });
  it('rejects a non-array', () => {
    expect(ok(parseCrossFilters('nope'))).toBe(false);
  });
});
