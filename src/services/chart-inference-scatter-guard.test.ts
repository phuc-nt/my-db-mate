/**
 * Phase-2 inference changes: scatter is inferrable for two-numeric results, but
 * shouldAutoChart must still only ever auto-open line/bar (protecting the
 * "Track as metric" gate, which keys on an auto-charted line). Existing label
 * cases must be unchanged.
 */
import { describe, it, expect } from 'vitest';
import { inferChartSpec, shouldAutoChart } from './chart-spec-service';

describe('inferChartSpec — existing cases unchanged', () => {
  it('temporal + numeric → line', () => {
    expect(inferChartSpec(['month', 'rev'], [['2026-01', 1]])).toEqual({ type: 'line', x: 'month', y: 'rev' });
  });
  it('categorical + numeric → bar', () => {
    expect(inferChartSpec(['seg', 'rev'], [['A', 1]])).toEqual({ type: 'bar', x: 'seg', y: 'rev' });
  });
  it('week/quarter now read as temporal → line', () => {
    expect(inferChartSpec(['quarter', 'rev'], [['Q1', 1]])?.type).toBe('line');
    expect(inferChartSpec(['week', 'rev'], [['W1', 1]])?.type).toBe('line');
  });
});

describe('inferChartSpec — scatter for two numerics', () => {
  it('two numeric columns, no label → scatter', () => {
    expect(inferChartSpec(['distance', 'fare'], [[1.2, 5], [3.4, 12]]))
      .toEqual({ type: 'scatter', x: 'distance', y: 'fare' });
  });
});

describe('shouldAutoChart — only line/bar auto-open', () => {
  it('scatter never auto-opens', () => {
    expect(shouldAutoChart(['distance', 'fare'], [[1.2, 5], [3.4, 12]])).toBeNull();
  });
  it('temporal still auto-opens as line', () => {
    expect(shouldAutoChart(['month', 'rev'], [['2026-01', 1], ['2026-02', 2]])?.type).toBe('line');
  });
  it('small categorical still auto-opens as bar', () => {
    expect(shouldAutoChart(['seg', 'rev'], [['A', 1], ['B', 2]])?.type).toBe('bar');
  });
});
