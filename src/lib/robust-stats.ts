/** Pure robust-statistics primitives for anomaly detection + drift monitoring.
 *  No DB imports — unit-testable without DATABASE_URL. Deliberately lightweight
 *  (rolling median+MAD, seasonal-naive baseline, CUSUM); no ML stack.
 *
 *  Every detector reports WHICH regime it used (robust vs a cold-start fallback)
 *  so callers can honestly say "baseline still warming up" instead of a
 *  false-confident verdict. History requirements come from the research report
 *  (plans/reports/researcher-260716-1704-*): MAD wants ~14 obs, weekly-seasonal
 *  ~21-28, monthly ~60-90. */

/** Below this many observations, MAD is unreliable — fall back to mean±σ. */
export const MIN_MAD_OBS = 14;
/** Below this many observations in a season bucket, drop seasonality → global MAD. */
export const MIN_SEASON_BUCKET_OBS = 4;
/** 1.4826 makes MAD a consistent estimator of σ for normally-distributed data. */
const MAD_SCALE = 1.4826;

export function mean(xs: number[]): number {
  if (xs.length === 0) return 0;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

export function sigma(xs: number[], mu = mean(xs)): number {
  if (xs.length === 0) return 0;
  const v = xs.reduce((a, b) => a + (b - mu) * (b - mu), 0) / xs.length;
  return Math.sqrt(Math.max(0, v));
}

export function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** Median absolute deviation, scaled to be σ-consistent. 0 when >half the values
 *  equal the median (a degenerate spread the caller must handle). */
export function mad(xs: number[], med = median(xs)): number {
  if (xs.length === 0) return 0;
  return MAD_SCALE * median(xs.map((x) => Math.abs(x - med)));
}

export interface OutlierVerdict {
  isOutlier: boolean;
  method: 'mad' | 'sigma-fallback';
  /** distance of `value` from centre, in robust (MAD) or σ units — for explanation. */
  score: number;
  centre: number;
  spread: number;
}

/** Is `value` an outlier vs the distribution `xs`? Uses median±k·MAD when there is
 *  enough data and MAD is non-degenerate; otherwise falls back to mean±k·σ. With
 *  neither spread available (constant series), only an exact-different value is an
 *  outlier. */
export function madOutlier(value: number, xs: number[], k = 3): OutlierVerdict {
  const useMad = xs.length >= MIN_MAD_OBS;
  if (useMad) {
    const med = median(xs);
    const m = mad(xs, med);
    if (m > 0) {
      const score = Math.abs(value - med) / m;
      return { isOutlier: score > k, method: 'mad', score, centre: med, spread: m };
    }
    // MAD degenerate (>half identical) → σ fallback below.
  }
  const mu = mean(xs);
  const s = sigma(xs, mu);
  if (s > 0) {
    const score = Math.abs(value - mu) / s;
    return { isOutlier: score > k, method: 'sigma-fallback', score, centre: mu, spread: s };
  }
  // No spread at all (constant series). Two sub-cases:
  //  - centre well away from 0: a value differing only slightly (metrics are often
  //    near-constant — a stable avg/rowCount) is NOT an anomaly; require a MATERIAL
  //    relative departure (5% of |centre|, the usual "material change" bar).
  //  - centre ≈ 0 (a metric legitimately hovering at 0 — net flow, delta, error rate):
  //    a relative bar collapses to ~0 and would flag every sub-percent reading as a
  //    huge anomaly. Without a caller-supplied absolute tolerance we CANNOT judge, so
  //    fail SAFE — report not-an-outlier rather than an alert storm. A zero-hovering
  //    metric needs an explicit absolute threshold at the call site.
  const CONST_TOLERANCE = 0.05;
  if (Math.abs(mu) < 1) {
    return { isOutlier: false, method: 'sigma-fallback', score: 0, centre: mu, spread: 0 };
  }
  const tol = Math.abs(mu) * CONST_TOLERANCE;
  const diff = Math.abs(value - mu);
  return { isOutlier: diff > tol, method: 'sigma-fallback', score: diff / tol, centre: mu, spread: 0 };
}

export type Season = 'dow' | 'month';

/** Season bucket key for a timestamp: day-of-week (0-6) or month (0-11). */
export function seasonKey(at: Date, season: Season): number {
  return season === 'dow' ? at.getUTCDay() : at.getUTCMonth();
}

export interface SeasonalVerdict {
  isOutlier: boolean;
  method: 'seasonal' | 'mad-fallback';
  seasonBucket: number;
  bucketN: number;
  score: number;
}

/** Judge `value@at` against ONLY its own season bucket's history (e.g. prior
 *  Tuesdays), so a value normal globally but abnormal for its weekday is caught.
 *  Falls back to a non-seasonal MAD over all history when the bucket is too thin. */
export function seasonalNaive(
  history: { value: number; at: Date }[],
  season: Season,
  value: number,
  at: Date,
  k = 3,
): SeasonalVerdict {
  const bucket = seasonKey(at, season);
  const inBucket = history.filter((h) => seasonKey(h.at, season) === bucket).map((h) => h.value);
  if (inBucket.length >= MIN_SEASON_BUCKET_OBS) {
    const v = madOutlier(value, inBucket, k);
    return { isOutlier: v.isOutlier, method: 'seasonal', seasonBucket: bucket, bucketN: inBucket.length, score: v.score };
  }
  const v = madOutlier(value, history.map((h) => h.value), k);
  return { isOutlier: v.isOutlier, method: 'mad-fallback', seasonBucket: bucket, bucketN: inBucket.length, score: v.score };
}

export interface CusumResult {
  /** Index within `recent` where a sustained shift was detected, or null. */
  shiftAt: number | null;
  direction?: 'up' | 'down';
  /** 'ok' when a real in-control baseline drove the check; 'insufficient-baseline'
   *  when there wasn't enough (or too degenerate) history to judge — shiftAt is null
   *  and the caller should treat drift as "unknown/warming up", not "no drift". */
  regime: 'ok' | 'insufficient-baseline';
}

/** Two-sided CUSUM level-shift detector. Correctly requires a SEPARATE in-control
 *  `baseline` (known-good history) to estimate the target level + scale, then scans
 *  `recent` observations for a sustained departure. This avoids the classic pitfall
 *  of estimating the target FROM data that already contains the shift (which inverts
 *  the alarm direction or hides an early/wide shift). `slack` (k, in σ) ignores small
 *  noise; `threshold` (h, in σ) is the alarm level; defaults k=0.5, h=5 (textbook).
 *
 *  Cold-start: if `baseline` has < MIN_MAD_OBS points, OR is so flat that no scale can
 *  be estimated (σ=0 and MAD=0) and the caller gave no explicit `scale`, returns
 *  `regime:'insufficient-baseline'` with shiftAt=null — the caller must NOT read that
 *  as "stable". Provide `scale` to force a check on a flat baseline. */
export function cusum(
  baseline: number[],
  recent: number[],
  opts: { slack?: number; threshold?: number; target?: number; scale?: number } = {},
): CusumResult {
  if (baseline.length < MIN_MAD_OBS || recent.length < 1) {
    return { shiftAt: null, regime: 'insufficient-baseline' };
  }
  const target = opts.target ?? median(baseline);
  // Scale estimated ONLY from the in-control baseline (never from `recent`, which may
  // contain the shift). If the baseline is genuinely flat and the caller gave no scale,
  // we can't set a meaningful alarm band → insufficient.
  const s = opts.scale ?? (sigma(baseline) || mad(baseline) || 0);
  if (s <= 0) return { shiftAt: null, regime: 'insufficient-baseline' };
  const k = (opts.slack ?? 0.5) * s;
  const h = (opts.threshold ?? 5) * s;
  const xs = recent;
  let cHi = 0;
  let cLo = 0;
  for (let i = 0; i < xs.length; i++) {
    cHi = Math.max(0, cHi + (xs[i] - target) - k);
    cLo = Math.min(0, cLo + (xs[i] - target) + k);
    if (cHi > h) return { shiftAt: i, direction: 'up', regime: 'ok' };
    if (cLo < -h) return { shiftAt: i, direction: 'down', regime: 'ok' };
  }
  return { shiftAt: null, regime: 'ok' };
}
