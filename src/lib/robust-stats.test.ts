import { describe, expect, it } from 'vitest';
import {
  mean,
  sigma,
  median,
  mad,
  madOutlier,
  seasonalNaive,
  seasonKey,
  cusum,
  MIN_MAD_OBS,
  MIN_SEASON_BUCKET_OBS,
} from './robust-stats';

describe('robust-stats', () => {
  describe('median', () => {
    it('odd-length array', () => {
      const xs = [3, 1, 4, 1, 5, 9, 2];
      expect(median(xs)).toBe(3);
    });

    it('even-length array — average of middle two', () => {
      const xs = [1, 2, 3, 4];
      expect(median(xs)).toBe(2.5);
    });

    it('single element', () => {
      expect(median([42])).toBe(42);
    });

    it('empty array → 0', () => {
      expect(median([])).toBe(0);
    });

    it('unsorted input (median sorts internally)', () => {
      const xs = [10, 5, 1, 8];
      expect(median(xs)).toBe(6.5); // sorted [1, 5, 8, 10]
    });

    it('array with duplicates', () => {
      const xs = [5, 5, 5, 5, 5];
      expect(median(xs)).toBe(5);
    });
  });

  describe('mean', () => {
    it('simple array', () => {
      expect(mean([1, 2, 3])).toBe(2);
    });

    it('empty array → 0', () => {
      expect(mean([])).toBe(0);
    });

    it('single element', () => {
      expect(mean([42])).toBe(42);
    });

    it('negative values', () => {
      expect(mean([-1, 0, 1])).toBe(0);
    });
  });

  describe('sigma (standard deviation)', () => {
    it('known series: σ for [1,2,3,4,5]', () => {
      // mean = 3, sum of (x - 3)^2 = 2 + 1 + 0 + 1 + 2 = 10, v = 10/5 = 2, σ = √2 ≈ 1.414
      const xs = [1, 2, 3, 4, 5];
      const s = sigma(xs);
      expect(Math.abs(s - Math.sqrt(2))).toBeLessThan(0.001);
    });

    it('constant series → σ = 0', () => {
      expect(sigma([5, 5, 5, 5])).toBe(0);
    });

    it('empty array → 0', () => {
      expect(sigma([])).toBe(0);
    });

    it('with supplied mean parameter', () => {
      const xs = [1, 3, 5];
      const mu = 3;
      // sum = (1-3)^2 + (3-3)^2 + (5-3)^2 = 4 + 0 + 4 = 8, v = 8/3, σ = √(8/3) ≈ 1.633
      const s = sigma(xs, mu);
      expect(Math.abs(s - Math.sqrt(8 / 3))).toBeLessThan(0.001);
    });
  });

  describe('mad (median absolute deviation)', () => {
    it('simple symmetric series: verify 1.4826 scaling', () => {
      // xs = [8, 9, 10, 11, 12], median = 10
      // absolute deviations: [2, 1, 0, 1, 2], median of those = 1
      // MAD = 1 * 1.4826 ≈ 1.4826
      const xs = [8, 9, 10, 11, 12];
      const m = mad(xs);
      expect(Math.abs(m - 1.4826)).toBeLessThan(0.001);
    });

    it('constant series (all identical) → mad = 0', () => {
      const xs = [7, 7, 7, 7, 7, 7];
      expect(mad(xs)).toBe(0);
    });

    it('empty array → 0', () => {
      expect(mad([])).toBe(0);
    });

    it('degenerate: >half values equal median → mad = 0', () => {
      // [5, 5, 5, 6, 6, 6, 7]: median = 6
      // abs devs: [1, 1, 1, 0, 0, 0, 1] → sorted: [0, 0, 0, 1, 1, 1, 1]
      // median of abs devs = 1, but we return 0 because >half equal median (the three 6s)
      // Actually, let me recount: [5, 5, 5, 6, 6, 6, 7], median = 6
      // abs devs from 6: [1, 1, 1, 0, 0, 0, 1]
      // sorted abs devs: [0, 0, 0, 1, 1, 1, 1], median = 1 * 1.4826
      // But the docstring says "returns 0 when >half the values equal the median"
      // [5, 5, 5, 6, 6, 6, 7]: 3 values equal median (6), 7 total, so 3/7 < 0.5 is false, >half is true (3/7 is not >0.5 though)
      // Let me create a clearer case: [10, 10, 10, 10, 10, 11] — 5 out of 6 equal median 10
      const xs = [10, 10, 10, 10, 10, 11];
      expect(mad(xs)).toBe(0);
    });

    it('with supplied median parameter', () => {
      const xs = [1, 2, 3, 4, 5];
      const med = 3;
      // abs devs: [2, 1, 0, 1, 2], median = 1, MAD = 1.4826
      const m = mad(xs, med);
      expect(Math.abs(m - 1.4826)).toBeLessThan(0.001);
    });
  });

  describe('madOutlier — robustness against masking', () => {
    it('MASKING CASE: MAD robust to extremes, σ fooled by them', () => {
      // Create a series of ~20 values near 10, plus three extreme values at 100.
      // The goal: MAD should flag value=50 as an outlier (abnormal for the bulk),
      // but naïve mean±3σ would NOT flag it.
      const series = [
        10, 10, 11, 9, 10, 10, 9, 11, 10, 10, 11, 9, 10, 10, 9, 11, 10, 10, 11, 9,
        100, 100, 100, // Three extreme outliers that inflate σ
      ];

      const testValue = 50;

      // Test MAD verdict
      const madVerdict = madOutlier(testValue, series, 3);
      expect(madVerdict.isOutlier).toBe(true);
      expect(madVerdict.method).toBe('mad');
      // MAD centre should be ~10, spread should be ~1.5 (robust to the 100s)
      expect(madVerdict.centre).toBeLessThan(12);
      expect(madVerdict.spread).toBeLessThan(2);

      // Now prove σ is fooled: compute mean±3σ on the same series
      const mu = mean(series);
      const s = sigma(series, mu);
      const meanPlusSigma = mu + 3 * s;
      // The 100s push mean & σ up, so mean+3σ >> 50; 50 < that bound
      expect(testValue).toBeLessThan(meanPlusSigma);
      // This proves: naïve mean±3σ would NOT flag 50, but MAD does.
    });

    it('cold-start: <MIN_MAD_OBS observations → sigma-fallback', () => {
      const series = [1, 2, 3, 4, 5]; // 5 < 14
      const verdict = madOutlier(10, series);
      expect(verdict.method).toBe('sigma-fallback');
    });

    it('MAD degenerate: >half identical, length≥MIN_MAD_OBS → sigma-fallback', () => {
      // 14 values: 10 identical, 4 spread
      const series = [5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 6, 7, 8, 9];
      // median = 5, abs devs all 0 except the four, so MAD = 0
      // Should fall back to σ
      const verdict = madOutlier(50, series);
      expect(verdict.method).toBe('sigma-fallback');
    });

    it('constant series, exact match → not outlier', () => {
      const series = [7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7];
      const verdict = madOutlier(7, series);
      expect(verdict.isOutlier).toBe(false);
      expect(verdict.spread).toBe(0);
      expect(verdict.score).toBe(0);
    });

    it('constant series, materially-different value → outlier', () => {
      const series = [7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7];
      // 42 is 500% above the constant 7 — far past the 5% material-change tolerance.
      const verdict = madOutlier(42, series);
      expect(verdict.isOutlier).toBe(true);
      expect(verdict.score).toBeGreaterThan(1);
    });

    it('constant series, near-identical value → NOT an outlier (material-change tolerance)', () => {
      const series = [100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100];
      expect(madOutlier(102, series).isOutlier).toBe(false); // +2% < 5% tolerance
      expect(madOutlier(110, series).isOutlier).toBe(true);  // +10% > 5% tolerance
    });

    it('zero-hovering constant series → fails SAFE (no alert storm on a sub-unit reading)', () => {
      // A metric legitimately at 0 (net flow / delta). A relative bar collapses to ~0,
      // so without a caller-supplied absolute threshold we must NOT flag every reading.
      const zeros = Array(14).fill(0);
      expect(madOutlier(0.001, zeros).isOutlier).toBe(false);
      expect(madOutlier(5, zeros).isOutlier).toBe(false); // still not judged — caller needs absTol
    });

    it('normal value in normal series → no false positive', () => {
      const series = [10, 11, 9, 12, 8, 11, 10, 9, 11, 10, 12, 9, 10, 11];
      const normalValue = 10;
      const verdict = madOutlier(normalValue, series, 3);
      expect(verdict.isOutlier).toBe(false);
    });

    it('strong outlier in normal series', () => {
      const series = [10, 11, 9, 12, 8, 11, 10, 9, 11, 10, 12, 9, 10, 11];
      const extremeValue = 200;
      const verdict = madOutlier(extremeValue, series, 3);
      expect(verdict.isOutlier).toBe(true);
    });
  });

  describe('seasonKey', () => {
    it('day-of-week for a known UTC date', () => {
      // 2026-07-16 is a Thursday (UTC)
      // new Date(2026, 6, 16) constructs 2026-07-16 in local time, but getUTCDay uses UTC
      // To be deterministic, use Date.UTC
      const date = new Date(Date.UTC(2026, 6, 16)); // Month 6 = July
      const dow = seasonKey(date, 'dow');
      expect(dow).toBe(4); // Thursday is 4 (0=Sun, 1=Mon, ..., 4=Thu)
    });

    it('month for a known UTC date', () => {
      const date = new Date(Date.UTC(2026, 6, 16));
      const month = seasonKey(date, 'month');
      expect(month).toBe(6); // July = 6 (0-indexed)
    });

    it('edge: Sunday is 0', () => {
      const date = new Date(Date.UTC(2026, 6, 12)); // July 12, 2026 is a Sunday
      expect(seasonKey(date, 'dow')).toBe(0);
    });

    it('edge: December is month 11', () => {
      const date = new Date(Date.UTC(2025, 11, 25));
      expect(seasonKey(date, 'month')).toBe(11);
    });
  });

  describe('seasonalNaive — catch seasonal anomalies', () => {
    it('SEASONAL CATCH: value abnormal for weekday, normal globally', () => {
      // Construct history: all Tuesdays have values ~10, all other days have values ~20.
      // Then judge a value of 50 on a Tuesday → should be flagged as anomalous for Tuesdays.
      const history: { value: number; at: Date }[] = [];

      // Tuesdays (dow=2) with value ~10 (need ≥4 observations)
      for (let i = 0; i < 6; i++) {
        // 2026-07-07 is a Tuesday
        const dayOffset = i * 7;
        const date = new Date(Date.UTC(2026, 6, 7 + dayOffset));
        history.push({ value: 10 + i % 2, at: date });
      }

      // Other days (non-Tuesday) with value ~20
      for (let i = 0; i < 10; i++) {
        // Mix of other weekdays
        const dayOffset = i * 7;
        const date = new Date(Date.UTC(2026, 6, 8 + dayOffset)); // Wednesday
        history.push({ value: 20 + (i % 3), at: date });
      }

      // Now test: value=50 on a Tuesday
      const testDate = new Date(Date.UTC(2026, 8, 1)); // Sept 1, 2026 is a Tuesday
      const verdict = seasonalNaive(history, 'dow', 50, testDate, 3);

      expect(verdict.method).toBe('seasonal');
      expect(verdict.isOutlier).toBe(true);
      expect(verdict.seasonBucket).toBe(2); // Tuesday
      expect(verdict.bucketN).toBeGreaterThanOrEqual(MIN_SEASON_BUCKET_OBS);
    });

    it('thin bucket: <MIN_SEASON_BUCKET_OBS → mad-fallback', () => {
      // Create history with only 2 observations for a specific weekday
      const history: { value: number; at: Date }[] = [];

      // Only 2 Tuesdays
      history.push({ value: 10, at: new Date(Date.UTC(2026, 6, 7)) });
      history.push({ value: 11, at: new Date(Date.UTC(2026, 6, 14)) });

      // Many Wednesdays and other days
      for (let i = 0; i < 20; i++) {
        const date = new Date(Date.UTC(2026, 6, 8 + i * 7));
        history.push({ value: 20, at: date });
      }

      const testDate = new Date(Date.UTC(2026, 8, 1)); // Tuesday
      const verdict = seasonalNaive(history, 'dow', 100, testDate, 3);

      expect(verdict.method).toBe('mad-fallback');
      expect(verdict.bucketN).toBeLessThan(MIN_SEASON_BUCKET_OBS);
    });

    it('seasonal with month bucket', () => {
      // Create history: all July values ~10, all other months ~20
      const history: { value: number; at: Date }[] = [];

      // July (month=6) — need ≥4 observations
      for (let day = 1; day <= 10; day += 2) {
        history.push({ value: 10, at: new Date(Date.UTC(2026, 6, day)) });
      }

      // Other months
      for (let month = 0; month < 12; month++) {
        if (month !== 6) {
          for (let day = 1; day <= 5; day += 2) {
            history.push({ value: 20, at: new Date(Date.UTC(2026, month, day)) });
          }
        }
      }

      // Test: value on a July date
      const testDate = new Date(Date.UTC(2026, 6, 15));
      const verdict = seasonalNaive(history, 'month', 50, testDate, 3);

      expect(verdict.method).toBe('seasonal');
      expect(verdict.seasonBucket).toBe(6);
      expect(verdict.isOutlier).toBe(true);
    });

    it('normal value in its season bucket → not outlier', () => {
      const history: { value: number; at: Date }[] = [];

      // Tuesdays with values 10-12
      for (let i = 0; i < 5; i++) {
        history.push({ value: 10 + i, at: new Date(Date.UTC(2026, 6, 7 + i * 7)) });
      }

      // Other days
      for (let i = 0; i < 10; i++) {
        history.push({ value: 50, at: new Date(Date.UTC(2026, 6, 8 + i * 7)) });
      }

      const testDate = new Date(Date.UTC(2026, 8, 1)); // Tuesday
      const verdict = seasonalNaive(history, 'dow', 11, testDate, 3); // 11 is normal for Tuesdays

      expect(verdict.isOutlier).toBe(false);
    });
  });

  describe('cusum — level-shift detection (baseline + recent)', () => {
    // A noisy but stable in-control baseline (≥ MIN_MAD_OBS, non-degenerate scale).
    const baseline10 = [10, 10.5, 9.8, 10.2, 9.9, 10.1, 10, 10.3, 9.7, 10.2, 10.1, 9.9, 10, 10.2];
    const baseline20 = baseline10.map((x) => x + 10);

    it('upward shift in recent → detected, direction up (baseline is in-control ~10)', () => {
      const recent = [10, 10, 20, 20, 20, 20, 20];
      const r = cusum(baseline10, recent);
      expect(r.regime).toBe('ok');
      expect(r.shiftAt).not.toBeNull();
      expect(r.direction).toBe('up');
    });

    it('downward shift in recent → detected, direction down (baseline ~20)', () => {
      const recent = [20, 20, 10, 10, 10, 10, 10];
      const r = cusum(baseline20, recent);
      expect(r.direction).toBe('down');
      expect(r.shiftAt).not.toBeNull();
    });

    it('shift at the VERY FIRST recent value is still detected with the right direction', () => {
      // Regression for the reviewer finding: an early/wide shift must not invert or vanish,
      // because target/scale come from the SEPARATE baseline, not the shifted data.
      const recent = [20, 20, 20, 20, 20, 20, 20];
      const r = cusum(baseline10, recent);
      expect(r.direction).toBe('up');
      expect(r.shiftAt).toBe(0);
    });

    it('stable recent (same level as baseline) → no shift', () => {
      const recent = [10, 9.9, 10.1, 10, 10.2, 9.8, 10];
      expect(cusum(baseline10, recent).shiftAt).toBeNull();
    });

    it('short baseline (< MIN_MAD_OBS) → insufficient-baseline, shiftAt null', () => {
      const r = cusum([10, 10, 10], [50, 50, 50]);
      expect(r.regime).toBe('insufficient-baseline');
      expect(r.shiftAt).toBeNull();
    });

    it('flat baseline with no scale → insufficient-baseline (cannot set an alarm band)', () => {
      const flat = Array(14).fill(10);
      const r = cusum(flat, [50, 50, 50]);
      expect(r.regime).toBe('insufficient-baseline');
      // ...but with an explicit scale, a flat baseline CAN be checked
      const r2 = cusum(flat, [50, 50, 50], { scale: 1 });
      expect(r2.regime).toBe('ok');
      expect(r2.direction).toBe('up');
    });

    it('empty recent → insufficient-baseline', () => {
      expect(cusum(baseline10, []).regime).toBe('insufficient-baseline');
    });
  });

  describe('MIN_MAD_OBS and MIN_SEASON_BUCKET_OBS constants', () => {
    it('MIN_MAD_OBS is 14', () => {
      expect(MIN_MAD_OBS).toBe(14);
    });

    it('MIN_SEASON_BUCKET_OBS is 4', () => {
      expect(MIN_SEASON_BUCKET_OBS).toBe(4);
    });
  });

  describe('integration: realistic anomaly detection scenario', () => {
    it('detect a spike in a stable, seasonal series', () => {
      // Simulate 8 weeks of daily metrics: baseline ~100 on weekdays, ~80 on weekends
      const history: { value: number; at: Date }[] = [];
      for (let week = 0; week < 8; week++) {
        for (let dow = 0; dow < 7; dow++) {
          const dayValue = dow >= 5 ? 80 : 100; // Weekdays 100, weekends 80
          const date = new Date(Date.UTC(2026, 5, 1 + week * 7 + dow));
          history.push({ value: dayValue, at: date });
        }
      }

      // Now test a spike on a weekday: should be flagged
      const testDate = new Date(Date.UTC(2026, 7, 15)); // Some weekday in the future
      const spikeValue = 500;
      const verdict = seasonalNaive(history, 'dow', spikeValue, testDate, 3);

      expect(verdict.isOutlier).toBe(true);
      expect(verdict.method).toBe('seasonal');
    });

    it('normal value passes seasonal + global checks', () => {
      const history: { value: number; at: Date }[] = [];
      for (let week = 0; week < 8; week++) {
        for (let dow = 0; dow < 7; dow++) {
          const dayValue = dow >= 5 ? 80 : 100;
          const date = new Date(Date.UTC(2026, 5, 1 + week * 7 + dow));
          history.push({ value: dayValue, at: date });
        }
      }

      // 2026-08-13 is a Thursday (getUTCDay()===4, a weekday whose bucket is all 100).
      const testDate = new Date(Date.UTC(2026, 7, 13));
      expect(testDate.getUTCDay()).toBe(4); // guard: it really is a weekday bucket
      const normalValue = 102; // +2% vs the 100 weekday baseline — within tolerance
      const verdict = seasonalNaive(history, 'dow', normalValue, testDate, 3);

      expect(verdict.isOutlier).toBe(false);
      // and a value that matches the WEEKEND baseline is abnormal for a weekday
      expect(seasonalNaive(history, 'dow', 80, testDate, 3).isOutlier).toBe(true);
    });
  });
});
