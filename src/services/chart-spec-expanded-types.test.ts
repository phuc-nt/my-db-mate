/**
 * Chart-spec expansion (V1): schema stays backward-compatible while the enum
 * grows, and the new types validate. Named *.test.ts so vitest's
 * include:['src/**\/*.test.ts'] actually runs it (a .tsx file would be skipped).
 */
import { describe, it, expect } from 'vitest';
import { ChartSpecSchema, validateChartSpec, inferChartSpec } from './chart-spec-service';

describe('ChartSpec backward compatibility', () => {
  it('parses an old {type,x,y} spec unchanged', () => {
    expect(validateChartSpec({ type: 'bar', x: 'month', y: 'revenue' }))
      .toEqual({ type: 'bar', x: 'month', y: 'revenue' });
  });

  it('parses an old stacked-bar spec with series', () => {
    const s = validateChartSpec({ type: 'stacked-bar', x: 'month', y: 'rev', series: 'segment' });
    expect(s?.type).toBe('stacked-bar');
    expect(s?.series).toBe('segment');
  });

  it('rejects an unknown type (returns null, no throw)', () => {
    expect(validateChartSpec({ type: 'sankey', x: 'a', y: 'b' })).toBeNull();
  });
});

describe('ChartSpec new types', () => {
  it('validates scatter with optional series', () => {
    expect(ChartSpecSchema.safeParse({ type: 'scatter', x: 'dist', y: 'fare', series: 'vendor' }).success).toBe(true);
  });
  it('validates combo with y2', () => {
    const s = validateChartSpec({ type: 'combo', x: 'month', y: 'revenue', y2: 'orders' });
    expect(s?.y2).toBe('orders');
  });
  it('validates stacked-100, heatmap, treemap', () => {
    for (const type of ['stacked-100', 'heatmap', 'treemap'] as const) {
      expect(ChartSpecSchema.safeParse({ type, x: 'a', y: 'b' }).success).toBe(true);
    }
  });
});

describe('inferChartSpec unchanged for existing cases', () => {
  it('temporal label + numeric → line', () => {
    const s = inferChartSpec(['month', 'revenue'], [['2026-01', 100], ['2026-02', 120]]);
    expect(s).toEqual({ type: 'line', x: 'month', y: 'revenue' });
  });
  it('categorical label + numeric → bar', () => {
    const s = inferChartSpec(['segment', 'revenue'], [['Consumer', 100], ['Corporate', 120]]);
    expect(s).toEqual({ type: 'bar', x: 'segment', y: 'revenue' });
  });
});
