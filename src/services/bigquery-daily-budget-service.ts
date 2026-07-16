/**
 * BigQuery per-connection daily byte-budget — reserve-then-reconcile.
 *
 * Cost-safety layer that lets background analytics (dashboards/metrics/reports)
 * run BigQuery unattended without a human confirming each cost, while capping the
 * day's total billed bytes. Sits ON TOP of the per-query `maximumBytesBilled` hard
 * cap — never replaces it.
 *
 * Why reserve-then-reconcile (not a lock held across the run): the real BigQuery
 * job is a multi-second network call. Holding a DB row lock across it would pile up
 * under parallel widget refreshes and starve the connection pool (Red Team #2).
 * Instead:
 *   1. `reserve()` — one short atomic conditional UPDATE. Admits only if
 *      `reserved + committed + estimate <= budget`. Returns false → caller blocks.
 *   2. caller runs the BigQuery job OUTSIDE any lock.
 *   3. `reconcile()` on success — move the estimate out of `reserved` and add the
 *      REAL billed bytes to `committed`; or `refund()` on any non-ok terminal path —
 *      release the reservation, commit nothing (Red Team #4: no reservation leak).
 *
 * "Day" is 00:00 UTC, matching the app's existing date convention
 * (`sql-param.ts` defaultDateRange uses UTC `toISOString().slice(0,10)`).
 */
import { and, eq, sql } from 'drizzle-orm';
import { db } from '../db/client';
import { bqBudgetLedger } from '../db/schema';

/** UTC day bucket 'YYYY-MM-DD' — the tally/reset boundary. Consistent with
 *  defaultDateRange so the budget day aligns with digest/report day boundaries. */
export function utcDayBucket(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/** Ensure the (connection, day) ledger row exists so the conditional UPDATE in
 *  `reserve` has a row to match. Idempotent via the unique (connection, day) key. */
async function ensureLedgerRow(connectionId: string, utcDay: string): Promise<void> {
  await db
    .insert(bqBudgetLedger)
    .values({ connectionId, utcDay, reservedBytes: 0, committedBytes: 0 })
    .onConflictDoNothing({ target: [bqBudgetLedger.connectionId, bqBudgetLedger.utcDay] });
}

/**
 * Atomically admit `estimateBytes` against the day's budget. Returns true if the
 * reservation was taken (caller may run the job), false if it would exceed budget
 * (caller must block). The single `UPDATE ... WHERE reserved + committed + estimate
 * <= budget` is the concurrency guard: two parallel callers cannot both admit past
 * the budget because the row's `reserved` is incremented atomically per admit.
 */
export async function reserve(
  connectionId: string,
  budgetBytes: number,
  estimateBytes: number,
  now: Date,
): Promise<boolean> {
  const utcDay = utcDayBucket(now);
  await ensureLedgerRow(connectionId, utcDay);
  const updated = await db
    .update(bqBudgetLedger)
    .set({
      reservedBytes: sql`${bqBudgetLedger.reservedBytes} + ${estimateBytes}`,
      updatedAt: now,
    })
    .where(
      and(
        eq(bqBudgetLedger.connectionId, connectionId),
        eq(bqBudgetLedger.utcDay, utcDay),
        sql`${bqBudgetLedger.reservedBytes} + ${bqBudgetLedger.committedBytes} + ${estimateBytes} <= ${budgetBytes}`,
      ),
    )
    .returning({ id: bqBudgetLedger.id });
  return updated.length > 0;
}

/** Settle a successful run: release the reservation and record the REAL billed bytes
 *  (or the per-query cap sentinel when the real figure was unreadable — Phase 1). */
export async function reconcile(
  connectionId: string,
  estimateBytes: number,
  billedBytes: number,
  now: Date,
): Promise<void> {
  const utcDay = utcDayBucket(now);
  await db
    .update(bqBudgetLedger)
    .set({
      reservedBytes: sql`GREATEST(${bqBudgetLedger.reservedBytes} - ${estimateBytes}, 0)`,
      committedBytes: sql`${bqBudgetLedger.committedBytes} + ${billedBytes}`,
      updatedAt: now,
    })
    .where(and(eq(bqBudgetLedger.connectionId, connectionId), eq(bqBudgetLedger.utcDay, utcDay)));
}

/** Release a reservation on any non-ok terminal path (maximumBytesBilled reject,
 *  execute threw) so an admitted-but-unrun query never permanently debits the day
 *  (Red Team #4). Commits nothing. */
export async function refund(connectionId: string, estimateBytes: number, now: Date): Promise<void> {
  const utcDay = utcDayBucket(now);
  await db
    .update(bqBudgetLedger)
    .set({
      reservedBytes: sql`GREATEST(${bqBudgetLedger.reservedBytes} - ${estimateBytes}, 0)`,
      updatedAt: now,
    })
    .where(and(eq(bqBudgetLedger.connectionId, connectionId), eq(bqBudgetLedger.utcDay, utcDay)));
}
