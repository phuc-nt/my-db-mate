import { describe, it, expect } from 'vitest';
import { stratifiedSample } from './bench-sampler';

/** A pool with BIRD mini-dev's own 30/50/20 difficulty mix. */
function pool(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    id: i,
    difficulty: i % 10 < 3 ? 'simple' : i % 10 < 8 ? 'moderate' : 'challenging',
  }));
}

const ids = (xs: { id: number }[]) => xs.map((x) => x.id).sort((a, b) => a - b);

describe('stratifiedSample', () => {
  it('returns exactly the requested size', () => {
    expect(stratifiedSample(pool(500), 100, 42)).toHaveLength(100);
  });

  it('draws the same questions from the same seed', () => {
    expect(ids(stratifiedSample(pool(500), 100, 42))).toEqual(ids(stratifiedSample(pool(500), 100, 42)));
  });

  it('draws different questions from a different seed', () => {
    // Without this, "deterministic" could be satisfied by a function that
    // ignores the seed and always takes the first N.
    expect(ids(stratifiedSample(pool(500), 100, 42))).not.toEqual(ids(stratifiedSample(pool(500), 100, 43)));
  });

  it('preserves the difficulty mix', () => {
    const sample = stratifiedSample(pool(500), 100, 7);
    const count = (d: string) => sample.filter((s) => s.difficulty === d).length;
    // 30/50/20 of 100, exactly — the proportions divide evenly here.
    expect(count('simple')).toBe(30);
    expect(count('moderate')).toBe(50);
    expect(count('challenging')).toBe(20);
  });

  it('still returns the exact size when the quota does not divide evenly', () => {
    // 500 items into 7: floor-then-apportion must hand out the leftovers.
    expect(stratifiedSample(pool(500), 7, 1)).toHaveLength(7);
    expect(stratifiedSample(pool(500), 33, 1)).toHaveLength(33);
  });

  it('returns the whole pool when the subset is not smaller', () => {
    expect(stratifiedSample(pool(20), 20, 1)).toHaveLength(20);
    expect(stratifiedSample(pool(20), 50, 1)).toHaveLength(20);
  });

  it('does not exceed a stratum that is smaller than its quota', () => {
    const lopsided = [
      ...Array.from({ length: 98 }, (_, i) => ({ id: i, difficulty: 'moderate' })),
      { id: 98, difficulty: 'simple' },
      { id: 99, difficulty: 'challenging' },
    ];
    const sample = stratifiedSample(lopsided, 50, 5);
    expect(sample).toHaveLength(50);
    expect(sample.filter((s) => s.difficulty === 'simple').length).toBeLessThanOrEqual(1);
  });

  it('handles items with no difficulty label', () => {
    const unlabelled = Array.from({ length: 40 }, (_, i) => ({ id: i }));
    expect(stratifiedSample(unlabelled, 10, 3)).toHaveLength(10);
  });

  it('does not depend on the order rows appear in the file', () => {
    // Map iteration order follows insertion, so a stratum's quota must not
    // change just because the dataset was shuffled on disk.
    const forward = pool(500);
    const reversed = [...forward].reverse();
    const mix = (xs: { difficulty?: string }[]) =>
      ['simple', 'moderate', 'challenging'].map((d) => xs.filter((x) => x.difficulty === d).length);
    expect(mix(stratifiedSample(reversed, 100, 9))).toEqual(mix(stratifiedSample(forward, 100, 9)));
  });
});
