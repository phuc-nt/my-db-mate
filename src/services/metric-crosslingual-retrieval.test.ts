/**
 * Cross-lingual metric retrieval guard (plan F phase 1).
 *
 * The 0.35 injection floor must let a genuinely-related metric through even when
 * the question and the metric name are in different languages, while still
 * excluding unrelated metrics. Measured against the REAL embedding model, so a
 * future model swap that regresses multilingual behavior fails here instead of
 * silently dropping governed metrics from chat (the original UAT symptom).
 *
 * Note: the plan's originally-cited 0.4295 miss (EN "monthly revenue" vs a VI
 * revenue metric) does NOT reproduce on the current model — it measures ~0.25,
 * well under the floor. This test locks that in and proves the floor still
 * discriminates against unrelated metrics.
 */
import { describe, it, expect } from 'vitest';
import { embed } from './embedding-service';

const FLOOR = 0.35; // mirrors METRIC_DISTANCE_FLOOR in context-service.ts

function distance(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return 1 - dot / (Math.sqrt(na) * Math.sqrt(nb));
}

describe('cross-lingual metric retrieval', () => {
  it('retrieves a VI-named revenue metric for an EN "monthly revenue" question', async () => {
    const q = await embed('monthly revenue');
    const viName = await embed('Doanh thu theo tháng'); // "monthly revenue" in Vietnamese
    expect(distance(q, viName)).toBeLessThan(FLOOR);
  });

  it('a bilingual description tightens the match (never loosens it)', async () => {
    const q = await embed('monthly revenue');
    const nameOnly = await embed('Doanh thu theo tháng');
    const withDesc = await embed('Doanh thu theo tháng\nMonthly revenue by month');
    expect(distance(q, withDesc)).toBeLessThanOrEqual(distance(q, nameOnly));
    expect(distance(q, withDesc)).toBeLessThan(FLOOR);
  });

  it('the floor still excludes an UNRELATED metric (no false injection)', async () => {
    const q = await embed('monthly revenue');
    const unrelated = await embed('Số lượng nhân viên đang hoạt động'); // "active employee count"
    expect(distance(q, unrelated)).toBeGreaterThan(FLOOR);
  });
});
