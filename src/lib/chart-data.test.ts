import { describe, expect, it } from 'vitest';
import { pivotLongToWide } from './chart-data';

describe('pivotLongToWide', () => {
  it('pivots long (x, series, y) to wide rows', () => {
    const rows = [
      ['2026-01', 'A', 10],
      ['2026-01', 'B', 5],
      ['2026-02', 'A', 20],
    ];
    const { data, seriesKeys } = pivotLongToWide(rows, 0, 1, 2);
    expect(seriesKeys).toEqual(['A', 'B']);
    expect(data).toEqual([
      { x: '2026-01', A: 10, B: 5 },
      { x: '2026-02', A: 20 },
    ]);
  });

  it('caps series and merges the tail into Other', () => {
    const rows: unknown[][] = [];
    for (let s = 0; s < 15; s++) rows.push(['x1', `s${s}`, 15 - s]);
    const { data, seriesKeys } = pivotLongToWide(rows, 0, 1, 2, 3);
    expect(seriesKeys).toEqual(['s0', 's1', 's2', 'Other']);
    // Other = sum of s3..s14 = 12+11+...+1 = 78
    expect(data[0].Other).toBe(78);
  });

  it('coerces string numbers, zeroes garbage, buckets null series', () => {
    const rows = [
      ['x', null, '7'],
      ['x', null, 'abc'],
    ];
    const { data, seriesKeys } = pivotLongToWide(rows, 0, 1, 2);
    expect(seriesKeys).toEqual(['(none)']);
    expect(data[0]['(none)']).toBe(7);
  });

  it('sums duplicate (x, series) pairs', () => {
    const { data } = pivotLongToWide([['x', 'A', 1], ['x', 'A', 2]], 0, 1, 2);
    expect(data[0].A).toBe(3);
  });
});
