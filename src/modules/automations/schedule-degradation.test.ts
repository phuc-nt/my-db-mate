/**
 * Cross-module degradation: a metrics_digest schedule when the metrics module
 * is switched off for this deployment.
 *
 * The interesting case is not that the digest fails — it is that it must fail
 * in a way that names the real cause. Without the module check the digest falls
 * through to "no metrics to digest — create metrics in the Metrics tab first",
 * which tells the operator to visit a tab this deployment does not have. That is
 * a wrong answer, not merely an unhelpful one, so the recorded reason is what
 * this test asserts on rather than just the status.
 *
 * Driven through the public `runSchedule` with a real row, because the guard is
 * only worth anything at the point the cron tick actually reaches it.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '@/core/db/client';
import { connections } from '@/core/db/schema';
import { scheduledQueries, scheduledRuns } from '@/core/db/ecosystem-schema';
import { encryptSecret } from '@/core/crypto/credential-cipher';
import { resetModuleCacheForTests } from '@/core/module-registry';
import { runSchedule } from './schedule-service';

const ORIGINAL = process.env.MODULES_DISABLED;

function setDisabled(value: string | undefined) {
  if (value === undefined) delete process.env.MODULES_DISABLED;
  else process.env.MODULES_DISABLED = value;
  resetModuleCacheForTests();
}

describe('metrics_digest schedule when the metrics module is off', () => {
  let connectionId: string;
  let scheduleId: string;

  beforeEach(async () => {
    const [conn] = await db
      .insert(connections)
      .values({
        name: 'test-digest-degradation-conn',
        kind: 'postgres-driver',
        dialect: 'postgres',
        config: { host: 'localhost' },
        secretEncrypted: encryptSecret('test'),
        isReadOnlyVerified: true,
      })
      .returning();
    connectionId = conn.id;

    const [sched] = await db
      .insert(scheduledQueries)
      .values({ connectionId, name: 'daily digest', mode: 'metrics_digest', cron: '0 7 * * *' })
      .returning();
    scheduleId = sched.id;
  });

  afterEach(async () => {
    setDisabled(ORIGINAL);
    await db.delete(connections).where(eq(connections.id, connectionId));
  });

  it('records a skip naming the disabled module, not a missing-metrics error', async () => {
    setDisabled('metrics');
    await runSchedule(scheduleId);

    const runs = await db.select().from(scheduledRuns).where(eq(scheduledRuns.scheduleId, scheduleId));
    expect(runs).toHaveLength(1);
    expect(runs[0].status).toBe('skipped');
    expect(runs[0].detail).toMatch(/metrics module is not enabled/i);
    // The misleading fallthrough must not be what the operator sees.
    expect(runs[0].detail).not.toMatch(/Metrics tab/i);
  });
});
