import { describe, it, expect } from 'vitest';
import { pivot } from './pivot';

const cols = ['status', 'amount'];
const rows: unknown[][] = [
  ['A', 10], ['A', 20], ['B', 5], ['B', null], ['C', '1,234'], ['C', '$6'],
];

describe('pivot', () => {
  it('count groups rows (ignores value col)', () => {
    const r = pivot(cols, rows, 'status', null, 'count');
    expect(r.columns).toEqual(['status', 'count']);
    expect(new Map(r.rows as [string, number][])).toEqual(new Map([['A', 2], ['B', 2], ['C', 2]]));
  });
  it('sum coerces and skips null/non-numeric', () => {
    const r = pivot(cols, rows, 'status', 'amount', 'sum');
    const m = new Map(r.rows as [string, number][]);
    expect(m.get('A')).toBe(30);
    expect(m.get('B')).toBe(5);          // null skipped
    expect(m.get('C')).toBe(1240);       // '1,234' + '$6'
  });
  it('avg over zero valid values → null (not NaN)', () => {
    const r = pivot(['g', 'v'], [['x', null], ['x', 'abc']], 'g', 'v', 'avg');
    expect((r.rows[0] as [string, unknown])[1]).toBeNull();
  });
  it('avg divides by count of VALID values', () => {
    const r = pivot(cols, rows, 'status', 'amount', 'avg');
    expect(new Map(r.rows as [string, number][]).get('A')).toBe(15); // (10+20)/2
    expect(new Map(r.rows as [string, number][]).get('B')).toBe(5);  // only 5 valid
  });
  it('min/max over numeric only', () => {
    expect(new Map(pivot(cols, rows, 'status', 'amount', 'min').rows as [string, number][]).get('C')).toBe(6);
    expect(new Map(pivot(cols, rows, 'status', 'amount', 'max').rows as [string, number][]).get('C')).toBe(1234);
  });
  it('null group key becomes a (null) bucket', () => {
    const r = pivot(['g', 'v'], [[null, 1], [null, 2], ['x', 3]], 'g', 'v', 'sum');
    const m = new Map(r.rows as [string, number][]);
    expect(m.get('(null)')).toBe(3);
    expect(m.get('x')).toBe(3);
  });
  it('sorts by aggregate descending, nulls last', () => {
    const r = pivot(['g', 'v'], [['a', 1], ['b', 5], ['c', null]], 'g', 'v', 'sum');
    expect((r.rows.map((x) => x[0]))).toEqual(['b', 'a', 'c']);
  });
});
