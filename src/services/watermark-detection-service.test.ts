import { describe, expect, it } from 'vitest';
import { detectWatermarkColumn } from './watermark-detection-service';

describe('detectWatermarkColumn', () => {
  it('picks a timestamp-named column with monotonically non-decreasing values', () => {
    const columns = ['id', 'name', 'updated_at'];
    const rows = [
      [1, 'a', new Date('2026-01-01')],
      [2, 'b', new Date('2026-01-02')],
      [3, 'c', new Date('2026-01-02')],
    ];
    expect(detectWatermarkColumn(columns, rows)).toBe('updated_at');
  });

  it('rejects a timestamp-named column whose values decrease', () => {
    const columns = ['id', 'created_at'];
    const rows = [
      [1, new Date('2026-01-03')],
      [2, new Date('2026-01-01')],
    ];
    expect(detectWatermarkColumn(columns, rows)).toBeNull();
  });

  it('ignores nulls when judging monotonicity (never-updated rows)', () => {
    const columns = ['id', 'updated_at'];
    const rows = [
      [1, null],
      [2, new Date('2026-01-01')],
      [3, null],
      [4, new Date('2026-01-02')],
    ];
    expect(detectWatermarkColumn(columns, rows)).toBe('updated_at');
  });

  it('returns null when no column name matches the candidate pattern', () => {
    const columns = ['id', 'name', 'value'];
    const rows = [[1, 'a', 10], [2, 'b', 20]];
    expect(detectWatermarkColumn(columns, rows)).toBeNull();
  });

  it('returns null when fewer than 2 non-null samples exist', () => {
    const columns = ['id', 'updated_at'];
    const rows = [[1, new Date('2026-01-01')], [2, null]];
    expect(detectWatermarkColumn(columns, rows)).toBeNull();
  });

  it('skips a non-monotonic candidate and falls through to a later valid one', () => {
    const columns = ['id', 'created_at', 'updated_at'];
    const rows = [
      [1, new Date('2026-01-05'), new Date('2026-01-01')],
      [2, new Date('2026-01-01'), new Date('2026-01-02')],
    ];
    expect(detectWatermarkColumn(columns, rows)).toBe('updated_at');
  });
});
