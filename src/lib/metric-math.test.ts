import { describe, expect, it } from 'vitest';
import { computeDelta, computeDrivers, computeInsights, formatMetricValue, guessGrain, parseSeries, renderDigestFallback, validateMetricShape } from './metric-math';

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

describe('computeInsights', () => {
  const mk = (vals: number[]) => vals.map((v, i) => ({ t: `2026-01-${String(i + 1).padStart(2, '0')}`, v }));

  it('flags a big drop vs prev and vs avg4 as bad for up_good', () => {
    const ins = computeInsights(mk([100, 100, 100, 100, 30]), 'up_good');
    expect(ins.deltaPct).toBe(-70);
    expect(ins.vsAvg4Pct).toBe(-70);
    expect(ins.goodness).toBe('bad');
    expect(ins.flags.join(' ')).toContain('vs prev');
  });

  it('same drop is good for down_good (errors falling)', () => {
    expect(computeInsights(mk([100, 100, 100, 100, 30]), 'down_good').goodness).toBe('good');
  });

  it('neutral direction never scores goodness', () => {
    expect(computeInsights(mk([100, 100, 100, 100, 30]), 'neutral').goodness).toBe('neutral');
  });

  it('detects ±2σ outlier on a stable series', () => {
    const ins = computeInsights(mk([100, 101, 99, 100, 101, 100, 300]), 'up_good');
    expect(ins.isOutlier).toBe(true);
    expect(ins.flags).toContain('outlier ±2σ');
  });

  it('no outlier when spread is normal', () => {
    expect(computeInsights(mk([100, 110, 90, 105, 95, 102]), 'up_good').isOutlier).toBe(false);
  });

  it('short series (1 point): all null, no flags, neutral', () => {
    const ins = computeInsights(mk([5]), 'up_good');
    expect(ins.deltaPct).toBeNull();
    expect(ins.vsAvg4Pct).toBeNull();
    expect(ins.isOutlier).toBe(false);
    expect(ins.flags).toEqual([]);
    expect(ins.goodness).toBe('neutral');
  });

  it('small move (<5%) stays neutral and unflagged', () => {
    const ins = computeInsights(mk([100, 100, 100, 100, 102]), 'up_good');
    expect(ins.goodness).toBe('neutral');
    expect(ins.flags.filter((f) => f.includes('vs prev'))).toEqual([]);
  });
});

describe('computeInsights — target', () => {
  const mk = (vals: number[]) => vals.map((v, i) => ({ t: `2026-01-${String(i + 1).padStart(2, '0')}`, v }));

  it('up_good below target → off_track + flag with pct', () => {
    const ins = computeInsights(mk([100, 88]), 'up_good', 100);
    expect(ins.targetStatus).toBe('off_track');
    expect(ins.targetPct).toBe(88);
    expect(ins.flags).toContain('below target (88%)');
  });

  it('up_good at/above target → on_track, no flag', () => {
    const ins = computeInsights(mk([90, 120]), 'up_good', 100);
    expect(ins.targetStatus).toBe('on_track');
    expect(ins.flags.some((f) => f.includes('target'))).toBe(false);
  });

  it('down_good above target → off_track "above target"', () => {
    const ins = computeInsights(mk([5, 12]), 'down_good', 10);
    expect(ins.targetStatus).toBe('off_track');
    expect(ins.flags.some((f) => f.startsWith('above target'))).toBe(true);
  });

  it('neutral: no status judgement, pct only', () => {
    const ins = computeInsights(mk([100, 88]), 'neutral', 100);
    expect(ins.targetStatus).toBeNull();
    expect(ins.targetPct).toBe(88);
    expect(ins.flags.some((f) => f.includes('target'))).toBe(false);
  });

  it('target 0 → pct null but status still computed', () => {
    const ins = computeInsights(mk([100, -5]), 'up_good', 0);
    expect(ins.targetPct).toBeNull();
    expect(ins.targetStatus).toBe('off_track');
  });

  it('no target → both null; changeFlags excludes target flag', () => {
    const ins = computeInsights(mk([100, 30]), 'up_good', 50);
    expect(ins.changeFlags.some((f) => f.includes('target'))).toBe(false);
    expect(ins.flags.some((f) => f.includes('target'))).toBe(true);
    const noTarget = computeInsights(mk([100, 30]), 'up_good');
    expect(noTarget.targetStatus).toBeNull();
    expect(noTarget.targetPct).toBeNull();
  });
});

describe('computeDrivers', () => {
  const rows = [
    ['2026-06', 100, 'A'], ['2026-06', 200, 'B'],
    ['2026-07', 40, 'A'], ['2026-07', 210, 'B'],
    ['2026-05', 999, 'A'], // older bucket — ignored
  ];

  it('ranks movers by |delta| with Σ|c| share', () => {
    const d = computeDrivers(rows, 'seg', '2026-07', '2026-06');
    expect(d.dimension).toBe('seg');
    expect(d.movers[0]).toEqual({ value: 'A', delta: -60, sharePct: (60 / 70) * 100 });
    expect(d.movers[1].value).toBe('B');
    expect(d.movers[1].delta).toBe(10);
  });

  it('new slice contributes +latest, vanished slice −prev', () => {
    const d = computeDrivers([
      ['2026-06', 50, 'gone'],
      ['2026-07', 30, 'new'],
    ], 'seg', '2026-07', '2026-06');
    const byVal = Object.fromEntries(d.movers.map((m) => [m.value, m.delta]));
    expect(byVal.gone).toBe(-50);
    expect(byVal.new).toBe(30);
  });

  it('null dim value buckets under (none)', () => {
    const d = computeDrivers([['2026-07', 5, null]], 'seg', '2026-07', '2026-06');
    expect(d.movers[0].value).toBe('(none)');
  });

  it('nothing moved → sharePct null', () => {
    const d = computeDrivers([
      ['2026-06', 10, 'A'], ['2026-07', 10, 'A'],
    ], 'seg', '2026-07', '2026-06');
    expect(d.movers[0].sharePct).toBeNull();
    expect(d.movers[0].delta).toBe(0);
  });

  it('duplicate (t, slice) rows are summed', () => {
    const d = computeDrivers([
      ['2026-07', 5, 'A'], ['2026-07', 7, 'A'],
    ], 'seg', '2026-07', '2026-06');
    expect(d.movers[0].delta).toBe(12);
  });

  it('empty rows → no movers', () => {
    expect(computeDrivers([], 'seg', '2026-07', '2026-06').movers).toEqual([]);
  });
});

describe('renderDigestFallback', () => {
  it('renders numbers-only markdown with goodness badges', () => {
    const md = renderDigestFallback([
      { name: 'Revenue', latest: 1_234_567, insight: { deltaPct: -12.3, vsAvg4Pct: null, isOutlier: false, flags: ['-12.3% vs prev'], changeFlags: ['-12.3% vs prev'], goodness: 'bad', targetStatus: null, targetPct: null } },
      { name: 'Errors', latest: 4, insight: { deltaPct: null, vsAvg4Pct: null, isOutlier: false, flags: [], changeFlags: [], goodness: 'neutral', targetStatus: null, targetPct: null } },
    ]);
    expect(md).toContain('## Metrics digest');
    expect(md).toContain('🔴 **Revenue**: 1.23M (-12.3% vs prev)');
    expect(md).toContain('⚪ **Errors**: 4');
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
