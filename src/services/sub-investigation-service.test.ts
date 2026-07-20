import { describe, it, expect } from 'vitest';
import { splitBudget, hasSurvivors } from './sub-investigation-service';
import type { SubInvestigationSnapshot } from '../lib/sub-investigation-types';

describe('splitBudget — static, race-free budget division (red-team M1)', () => {
  it('divides the default investigate cap without exceeding it', () => {
    // 30 SQL / 24 steps, N=2..4
    for (const n of [2, 3, 4]) {
      const b = splitBudget(30, 24, n);
      expect(b.maxSql * b.n).toBeLessThanOrEqual(30);
      expect(b.maxSteps * b.n).toBeLessThanOrEqual(24);
      expect(b.maxSql).toBeGreaterThanOrEqual(4);
      expect(b.maxSteps).toBeGreaterThanOrEqual(6);
    }
  });

  it('divides the deep cap without exceeding it', () => {
    for (const n of [2, 3, 4]) {
      const b = splitBudget(60, 48, n);
      expect(b.maxSql * b.n).toBeLessThanOrEqual(60);
      expect(b.maxSteps * b.n).toBeLessThanOrEqual(48);
    }
  });

  it('REDUCES N when a lowered env cap cannot give each sub the minimum (M1)', () => {
    // Env-lowered cap: 8 SQL, N=4 requested → each would get 2 (<4) → N reduced.
    const b = splitBudget(8, 12, 4);
    expect(b.n).toBeLessThan(4);
    expect(b.maxSql).toBeGreaterThanOrEqual(4);
    expect(b.maxSql * b.n).toBeLessThanOrEqual(8); // never exceeds parent
  });

  it('handles a cap smaller than the per-sub minimum by collapsing to N=1', () => {
    const b = splitBudget(5, 6, 3);
    expect(b.n).toBe(1);
    expect(b.maxSql).toBeLessThanOrEqual(5);
  });

  it('clamps requested N to at most 4', () => {
    const b = splitBudget(30, 24, 9);
    expect(b.n).toBeLessThanOrEqual(4);
  });
});

const snap = (over: Partial<SubInvestigationSnapshot>): SubInvestigationSnapshot => ({
  id: 'x', title: 't', status: 'pending', queries: [], ...over,
});

describe('hasSurvivors (red-team M2)', () => {
  it('true when at least one sub is done with a conclusion', () => {
    expect(hasSurvivors([snap({ status: 'error', error: 'boom' }), snap({ status: 'done', conclusion: 'found it' })])).toBe(true);
  });
  it('false when all failed or produced no conclusion', () => {
    expect(hasSurvivors([snap({ status: 'error' }), snap({ status: 'done', conclusion: '' })])).toBe(false);
    expect(hasSurvivors([])).toBe(false);
  });
});
