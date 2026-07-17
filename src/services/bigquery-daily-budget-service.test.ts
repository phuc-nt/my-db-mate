/**
 * Priority-based budget reservation (BigQuery cost-governance hardening, Phase 1).
 *
 * `effectiveBudget` is pure and tested in isolation; the fairness/atomicity tests
 * exercise the REAL `reserve` UPDATE against a real Postgres ledger so the
 * priority-as-smaller-ceiling design is verified against the actual concurrency guard.
 */
import 'dotenv/config';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '../db/client';
import { connections, bqBudgetLedger } from '../db/schema';
import { reserve, effectiveBudget, isLowTierActor, LOW_TIER_FRACTION } from './bigquery-daily-budget-service';

describe('effectiveBudget (pure)', () => {
  const BUDGET = 1_000_000;

  it('interactive (non-backgroundBudgeted) gets the full budget regardless of actor', () => {
    expect(effectiveBudget(BUDGET, 'browse', false)).toBe(BUDGET);
    expect(effectiveBudget(BUDGET, 'monitor', false)).toBe(BUDGET); // interactive wins even for a maintenance actor name
    expect(effectiveBudget(BUDGET, 'owner', undefined)).toBe(BUDGET);
  });

  it('low-tier maintenance actors (monitor/anomaly) get budget * LOW_TIER_FRACTION', () => {
    expect(effectiveBudget(BUDGET, 'monitor', true)).toBe(Math.floor(BUDGET * LOW_TIER_FRACTION));
    expect(effectiveBudget(BUDGET, 'anomaly', true)).toBe(Math.floor(BUDGET * LOW_TIER_FRACTION));
  });

  it('BI surfaces (dashboard/metric*/report) get the full budget when background', () => {
    for (const actor of ['dashboard', 'metric', 'metric-driver', 'metric-validate', 'report']) {
      expect(effectiveBudget(BUDGET, actor, true)).toBe(BUDGET);
    }
  });

  it('an unknown background actor defaults to full budget (explicit opt-in for low tier)', () => {
    expect(effectiveBudget(BUDGET, 'some-future-feature', true)).toBe(BUDGET);
  });
});

describe('isLowTierActor (classification, budget-independent)', () => {
  it('true only for monitor/anomaly running as background', () => {
    expect(isLowTierActor('monitor', true)).toBe(true);
    expect(isLowTierActor('anomaly', true)).toBe(true);
    expect(isLowTierActor('dashboard', true)).toBe(false);
    expect(isLowTierActor('monitor', false)).toBe(false); // interactive is never low-tier
  });

  it('classifies the tier even when the budget is 0 (so a zero-budget block message is still accurate)', () => {
    // effectiveBudget(0, 'monitor', true) === 0 === effectiveBudget(0, 'dashboard', true),
    // so a `ceiling < budget` check can't tell them apart — isLowTierActor can.
    expect(effectiveBudget(0, 'monitor', true)).toBe(0);
    expect(isLowTierActor('monitor', true)).toBe(true);
  });
});

describe('reserve — priority ceiling fairness (real ledger)', () => {
  let connId: string;
  const now = new Date('2026-07-17T12:00:00.000Z');
  const BUDGET = 1_000_000;
  const LOW = Math.floor(BUDGET * LOW_TIER_FRACTION); // 500_000

  beforeEach(async () => {
    const [row] = await db.insert(connections).values({
      name: 'bq-budget-priority-test',
      kind: 'bigquery-driver',
      dialect: 'bigquery',
      config: { projectId: 'test-project' },
      isReadOnlyVerified: true,
      bigqueryMaxBytesPerQuery: 1_073_741_824,
    }).returning();
    connId = row.id;
  });

  afterEach(async () => {
    await db.delete(bqBudgetLedger).where(eq(bqBudgetLedger.connectionId, connId));
    await db.delete(connections).where(eq(connections.id, connId));
  });

  it('low-tier is blocked past its fraction even though the full pool has room; high-tier then uses the headroom', async () => {
    // A monitor (low tier) reserves against LOW=500k. First 400k admitted.
    expect(await reserve(connId, effectiveBudget(BUDGET, 'monitor', true), 400_000, now)).toBe(true);
    // Another 200k monitor admit would push reserved to 600k > LOW ceiling → blocked,
    // even though the FULL pool (1M) still has 600k free.
    expect(await reserve(connId, effectiveBudget(BUDGET, 'monitor', true), 200_000, now)).toBe(false);
    // A dashboard (full ceiling) sees the real 400k reserved and admits into the full-pool headroom.
    expect(await reserve(connId, effectiveBudget(BUDGET, 'dashboard', true), 500_000, now)).toBe(true);
    // Ledger now reserved 900k; a further 200k (any tier) exceeds the full budget → blocked.
    expect(await reserve(connId, effectiveBudget(BUDGET, 'dashboard', true), 200_000, now)).toBe(false);
  });

  it('interactive (full ceiling) is never sub-ceiled by the low-tier fraction', async () => {
    // Interactive can reserve past the low fraction up to the full budget.
    expect(await reserve(connId, effectiveBudget(BUDGET, 'browse', false), 800_000, now)).toBe(true);
  });

  it('two concurrent low-tier admits cannot collectively exceed the fraction (atomicity holds)', async () => {
    // Both try 300k against the LOW=500k ceiling concurrently; only one can win (300+300=600 > 500).
    const [a, b] = await Promise.all([
      reserve(connId, LOW, 300_000, now),
      reserve(connId, LOW, 300_000, now),
    ]);
    expect([a, b].filter(Boolean)).toHaveLength(1);
  });
});
