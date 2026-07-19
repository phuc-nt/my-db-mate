/**
 * probeWidget's BigQuery dry-run branch: the cost-preview path returns
 * `needs_cost_confirmation` on a successful estimate, and the probe must treat
 * that as a PASS (the query parsed + priced). Regression for a real bug found by
 * live-BigQuery UAT — every generated BQ widget failed the probe because this
 * status wasn't recognised. executeQuery is mocked so no BigQuery call is made.
 */
import { describe, it, expect, vi } from 'vitest';

const execMock = vi.fn();
vi.mock('./query-executor-service', () => ({ executeQuery: (...a: unknown[]) => execMock(...a) }));
vi.mock('./dashboard-service', () => ({ checkWidgetSql: async () => ({ ok: true, sqlForChecks: 'SELECT 1', isParametrized: false }) }));

describe('probeWidget BigQuery dry-run', () => {
  it('needs_cost_confirmation from the cost-preview counts as a passing dry-run', async () => {
    const { probeWidget } = await import('./dashboard-generation-service');
    execMock.mockResolvedValue({ status: 'needs_cost_confirmation' });
    const r = await probeWidget('conn', 'SELECT 1', true);
    expect(r.ok).toBe(true);
    expect(r.dryRun).toBe(true);
  });

  it('ok and needs_confirmation also pass', async () => {
    const { probeWidget } = await import('./dashboard-generation-service');
    for (const status of ['ok', 'needs_confirmation'] as const) {
      execMock.mockResolvedValue({ status });
      expect((await probeWidget('conn', 'SELECT 1', true)).ok).toBe(true);
    }
  });

  it('blocked / error fail the dry-run', async () => {
    const { probeWidget } = await import('./dashboard-generation-service');
    execMock.mockResolvedValue({ status: 'blocked', blockedReason: 'over budget' });
    const r = await probeWidget('conn', 'SELECT 1', true);
    expect(r.ok).toBe(false);
    expect(r.error).toContain('over budget');
  });
});
