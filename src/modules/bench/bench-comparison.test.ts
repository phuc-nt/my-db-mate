import { describe, it, expect } from 'vitest';
import { configKey, spreadsByConfig, DISQUALIFYING_MARKERS, type ComparableSummary } from './bench-comparison';

function summary(over: Partial<ComparableSummary> = {}): ComparableSummary {
  return { model: 'qwen/qwen3.7-max', contextLayer: true, questionCount: 20, executionAccuracyPct: 25, ...over };
}

describe('configKey', () => {
  it('separates the ablation, so a context-on and context-off run never share a spread', () => {
    expect(configKey(summary({ contextLayer: true })))
      .not.toBe(configKey(summary({ contextLayer: false })));
  });

  it('separates models', () => {
    expect(configKey(summary({ model: 'a/one' }))).not.toBe(configKey(summary({ model: 'b/two' })));
  });

  it('separates subset sizes, because a 5-question run is not a rerun of a 20-question one', () => {
    expect(configKey(summary({ questionCount: 5 }))).not.toBe(configKey(summary({ questionCount: 20 })));
  });

  it('ignores accuracy, so two runs of one config group together', () => {
    expect(configKey(summary({ executionAccuracyPct: 20 })))
      .toBe(configKey(summary({ executionAccuracyPct: 30 })));
  });
});

describe('spreadsByConfig', () => {
  it('reports the gap between two runs of the same configuration', () => {
    const out = spreadsByConfig([
      summary({ executionAccuracyPct: 20 }),
      summary({ executionAccuracyPct: 30 }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ runs: 2, minPct: 20, maxPct: 30, spreadPts: 10 });
  });

  it('gives no spread for a configuration run once — one run cannot show reproducibility', () => {
    expect(spreadsByConfig([summary()])).toEqual([]);
  });

  it('does not mix configurations: an ablation delta is not a spread', () => {
    const out = spreadsByConfig([
      summary({ contextLayer: true, executionAccuracyPct: 40 }),
      summary({ contextLayer: false, executionAccuracyPct: 10 }),
    ]);
    // Each config has one run, so nothing is reproducible — and the 30-point
    // ablation delta must never surface as run-to-run noise.
    expect(out).toEqual([]);
  });

  it('groups per configuration when several configurations each ran twice', () => {
    const out = spreadsByConfig([
      summary({ contextLayer: true, executionAccuracyPct: 20 }),
      summary({ contextLayer: true, executionAccuracyPct: 30 }),
      summary({ contextLayer: false, executionAccuracyPct: 5 }),
      summary({ contextLayer: false, executionAccuracyPct: 5 }),
    ]);
    expect(out).toHaveLength(2);
    expect(out.find((s) => s.key.includes('ctx=on'))?.spreadPts).toBe(10);
    expect(out.find((s) => s.key.includes('ctx=off'))?.spreadPts).toBe(0);
  });

  it('uses the extremes across more than two runs, not the last pair', () => {
    const out = spreadsByConfig([15, 45, 30].map((executionAccuracyPct) => summary({ executionAccuracyPct })));
    expect(out[0]).toMatchObject({ runs: 3, minPct: 15, maxPct: 45, spreadPts: 30 });
  });
});

describe('DISQUALIFYING_MARKERS', () => {
  it('covers both markers the harness writes', () => {
    expect([...DISQUALIFYING_MARKERS].sort()).toEqual(['INVALID.md', 'PARTIAL.md']);
  });
});
