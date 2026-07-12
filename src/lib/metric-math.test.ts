import { describe, expect, it } from 'vitest';
import { computeDelta, formatMetricValue, guessGrain, parseSeries, validateMetricShape } from './metric-math';

describe('parseSeries', () => {
  it('sorts non-chronological input and drops invalid rows', () => {
    const rows = [
      ['2026-03-01', 30],
      ['2026-01-01', '10'],
      ['not-a-date', 99],
      ['2026-02-01', null],
      ['2026-02-01', 20],
    ];
    expect(parseSeries(rows)).toEqual([
      { t: '2026-01-01', v: 10 },
      { t: '2026-02-01', v: 20 },
      { t: '2026-03-01', v: 30 },
    ]);
  });

  it('returns empty for empty input', () => {
    expect(parseSeries([])).toEqual([]);
  });
});

describe('computeDelta', () => {
  it('computes percent change vs previous bucket', () => {
    const d = computeDelta(parseSeries([['2026-01-01', 100], ['2026-02-01', 125]]));
    expect(d).toEqual({ latest: 125, prev: 100, deltaPct: 25 });
  });

  it('single point → no prev, no deltaPct', () => {
    expect(computeDelta([{ t: '2026-01-01', v: 5 }])).toEqual({ latest: 5, prev: null, deltaPct: null });
  });

  it('prev=0 → deltaPct null, not Infinity', () => {
    const d = computeDelta([{ t: 'a', v: 0 }, { t: 'b', v: 10 }].map((p, i) => ({ t: `2026-0${i + 1}-01`, v: p.v })));
    expect(d.deltaPct).toBeNull();
  });

  it('negative prev uses absolute base', () => {
    const d = computeDelta([{ t: '2026-01-01', v: -100 }, { t: '2026-02-01', v: -50 }]);
    expect(d.deltaPct).toBe(50);
  });
});

describe('guessGrain', () => {
  it('daily gaps → day', () => {
    expect(guessGrain([['2026-01-01', 1], ['2026-01-02', 2], ['2026-01-03', 3]])).toBe('day');
  });
  it('weekly gaps → week', () => {
    expect(guessGrain([['2026-01-05', 1], ['2026-01-12', 2], ['2026-01-19', 3]])).toBe('week');
  });
  it('monthly gaps → month', () => {
    expect(guessGrain([['2026-01-01', 1], ['2026-02-01', 2], ['2026-03-01', 3]])).toBe('month');
  });
  it('too few points defaults to month', () => {
    expect(guessGrain([['2026-01-01', 1]])).toBe('month');
  });
});

describe('validateMetricShape', () => {
  it('accepts (time, numeric)', () => {
    expect(validateMetricShape(['month', 'revenue'], [['2026-01-01', 100]])).toEqual({ ok: true });
  });
  it('rejects wrong column count with clear message', () => {
    const r = validateMetricShape(['a', 'b', 'c'], [['x', 1, 2]]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('exactly 2 columns');
  });
  it('rejects non-temporal first column', () => {
    const r = validateMetricShape(['region', 'revenue'], [['north', 1], ['south', 2]]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('date/time');
  });
  it('rejects non-numeric second column', () => {
    const r = validateMetricShape(['month', 'label'], [['2026-01-01', 'abc'], ['2026-02-01', 'def']]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('numeric');
  });
  it('rejects empty result', () => {
    const r = validateMetricShape(['month', 'v'], []);
    expect(r.ok).toBe(false);
  });
  it('tolerates 20% dirty rows', () => {
    const rows = [
      ['2026-01-01', 1], ['2026-02-01', 2], ['2026-03-01', 3], ['2026-04-01', 4], ['bad', 'bad'],
    ];
    expect(validateMetricShape(['month', 'v'], rows)).toEqual({ ok: true });
  });
});

describe('formatMetricValue', () => {
  it('formats magnitudes compactly', () => {
    expect(formatMetricValue(1_234_567)).toBe('1.23M');
    expect(formatMetricValue(45_600)).toBe('45.6K');
    expect(formatMetricValue(42)).toBe('42');
    expect(formatMetricValue(3.14159)).toBe('3.14');
    expect(formatMetricValue(null)).toBe('—');
  });
});
