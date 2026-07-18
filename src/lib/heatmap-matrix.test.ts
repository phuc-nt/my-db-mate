/**
 * buildHeatmapMatrix: order-preserving pivot for the heatmap renderer.
 * Contrast with pivotLongToWide (sorts series by total, merges 'Other', 0-fills)
 * which the red-team flagged as unfit for a time-axis heatmap.
 */
import { describe, it, expect } from 'vitest';
import { buildHeatmapMatrix, HEATMAP_AXIS_CAP } from './chart-data';

// rows: [x=month, series=segment, y=revenue]
const rows = [
  ['2026-01', 'Consumer', 100],
  ['2026-01', 'Corporate', 50],
  ['2026-02', 'Consumer', 120],
  // 2026-02 Corporate missing → null cell
  ['2026-03', 'Consumer', 90],
];

describe('buildHeatmapMatrix', () => {
  it('keeps first-seen order on both axes (no sort by total)', () => {
    const m = buildHeatmapMatrix(rows, 0, 1, 2);
    expect(m.xKeys).toEqual(['2026-01', '2026-02', '2026-03']);
    expect(m.seriesKeys).toEqual(['Consumer', 'Corporate']);
  });

  it('missing (x, series) pairs are null, not 0', () => {
    const m = buildHeatmapMatrix(rows, 0, 1, 2);
    expect(m.cells.get('Corporate')?.get('2026-02') ?? null).toBeNull();
    expect(m.cells.get('Consumer')?.get('2026-02')).toBe(120);
  });

  it('min/max exclude the missing cells', () => {
    const m = buildHeatmapMatrix(rows, 0, 1, 2);
    expect(m.min).toBe(50);
    expect(m.max).toBe(120);
  });

  it('flags tooLarge past the axis cap', () => {
    const big = Array.from({ length: HEATMAP_AXIS_CAP + 1 }, (_, i) => [`x${i}`, 's', 1]);
    expect(buildHeatmapMatrix(big, 0, 1, 2).tooLarge).toBe(true);
  });

  it('handles all-empty numeric gracefully', () => {
    const m = buildHeatmapMatrix([['a', 's', 'not-a-number']], 0, 1, 2);
    expect(m.min).toBe(0);
    expect(m.max).toBe(0);
  });
});
