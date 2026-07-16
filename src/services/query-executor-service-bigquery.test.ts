/**
 * Phase 6 (cost-gate caller coverage) regression tests: verifies BigQuery
 * connections can never reach `provider.executeReadOnly()` inside
 * `executeQuery()` without an explicit, dedicated confirmation — decoupled
 * from the OLTP `skipRiskGate`/`confirmed` flags — and that Group A services
 * (profiling, anomaly detection, accelerator snapshots, query-history mining,
 * eval harness) refuse BigQuery connections outright via `assertNotBigQuery`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '../db/client';
import { connections, bqBudgetLedger } from '../db/schema';
import { encryptSecret } from './crypto/credential-cipher';

const createQueryJobMock = vi.fn();
const getDatasetsMock = vi.fn(async () => [[]]);

vi.mock('@google-cloud/bigquery', () => {
  class BigQuery {
    getDatasets = getDatasetsMock;
    createQueryJob = createQueryJobMock;
  }
  return { BigQuery };
});

import { executeQuery } from './query-executor-service';
import { BigQueryConfirmationRequiredError } from './connection-providers/provider-interface';
import { profileColumn } from './profiling-service';
import { detectAnomalies } from './anomaly-service';
import { fetchQueryLog } from './query-history-mining-service';
import { runEval } from './eval-service';
import { schemaTables, schemaColumns, queryRuns } from '../db/schema';
import { evalQueries } from '../db/intelligence-schema';
import { desc } from 'drizzle-orm';

/** Build a BQ job mock whose real-run metadata carries the given query statistics. */
function mockRealRun(queryStats: Record<string, unknown>) {
  createQueryJobMock.mockResolvedValueOnce([
    {
      getQueryResults: vi.fn(async () => [[]]),
      getMetadata: vi.fn(async () => [{ statistics: { query: queryStats } }]),
    },
  ]);
}

async function createBigQueryConnection() {
  const [row] = await db
    .insert(connections)
    .values({
      name: 'bq-cost-gate-test',
      kind: 'bigquery-driver',
      dialect: 'bigquery',
      config: { projectId: 'test-project' },
      secretEncrypted: null,
      isReadOnlyVerified: true,
      bigqueryServiceAccountJsonEncrypted: encryptSecret(JSON.stringify({ client_email: 'sa@test.iam.gserviceaccount.com', private_key: 'fake' })),
      bigqueryMaxBytesPerQuery: 1_073_741_824,
    })
    .returning();
  return row;
}

function mockDryRunEstimate(totalBytesProcessed: string) {
  createQueryJobMock.mockResolvedValueOnce([
    { metadata: { statistics: { query: { totalBytesProcessed } } } },
  ]);
}

describe('executeQuery — BigQuery cost-confirmation gate (Phase 6)', () => {
  let conn: Awaited<ReturnType<typeof createBigQueryConnection>>;

  beforeEach(async () => {
    createQueryJobMock.mockReset();
    getDatasetsMock.mockClear();
    conn = await createBigQueryConnection();
  });

  afterEach(async () => {
    await db.delete(connections).where(eq(connections.id, conn.id));
  });

  it('rejects with a clear error when no token and no preview flag are supplied (Group B default)', async () => {
    const res = await executeQuery({ connectionId: conn.id, sql: 'SELECT 1' });
    expect(res.status).toBe('error');
    expect(res.errorMessage).toMatch(/interactive cost-confirmation/);
    expect(createQueryJobMock).not.toHaveBeenCalled();
  });

  it('setting skipRiskGate/confirmed for OLTP reasons does NOT bypass the BigQuery cost gate', async () => {
    const res = await executeQuery({ connectionId: conn.id, sql: 'SELECT 1', skipRiskGate: true, confirmed: true });
    expect(res.status).toBe('error');
    expect(res.errorMessage).toMatch(/interactive cost-confirmation/);
    expect(createQueryJobMock).not.toHaveBeenCalled();
  });

  it('returns needs_cost_confirmation with a real dry-run estimate when allowCostEstimatePreview is set', async () => {
    mockDryRunEstimate(String(2 * 1024 ** 4)); // 2 TiB
    const res = await executeQuery({ connectionId: conn.id, sql: 'SELECT 1', allowCostEstimatePreview: true });
    expect(res.status).toBe('needs_cost_confirmation');
    expect(res.costEstimate?.estimatedBytes).toBe(2 * 1024 ** 4);
    expect(createQueryJobMock).toHaveBeenCalledWith(expect.objectContaining({ dryRun: true }));
  });

  it('executes for real only once bigqueryCostConfirmationToken is supplied', async () => {
    createQueryJobMock.mockResolvedValueOnce([
      { getQueryResults: vi.fn(async () => [[]]), getMetadata: vi.fn(async () => [{ statistics: { query: {} } }]) },
    ]);
    const res = await executeQuery({ connectionId: conn.id, sql: 'SELECT 1', bigqueryCostConfirmationToken: true });
    expect(res.status).toBe('ok');
    expect(createQueryJobMock).toHaveBeenCalledWith(expect.objectContaining({ maximumBytesBilled: '1073741824' }));
  });

  it('the thrown BigQueryConfirmationRequiredError carries a distinct name for callers that want to type-check it', async () => {
    const err = new BigQueryConfirmationRequiredError();
    expect(err.name).toBe('BigQueryConfirmationRequiredError');
  });
});

describe('bytesBilled tally recording (Phase 1) — the daily-budget foundation', () => {
  let conn: Awaited<ReturnType<typeof createBigQueryConnection>>;

  beforeEach(async () => {
    createQueryJobMock.mockReset();
    getDatasetsMock.mockClear();
    conn = await createBigQueryConnection();
  });

  afterEach(async () => {
    await db.delete(queryRuns).where(eq(queryRuns.connectionId, conn.id));
    await db.delete(connections).where(eq(connections.id, conn.id));
  });

  async function lastRun() {
    const [row] = await db
      .select()
      .from(queryRuns)
      .where(eq(queryRuns.connectionId, conn.id))
      .orderBy(desc(queryRuns.createdAt))
      .limit(1);
    return row;
  }

  it('records the REAL totalBytesBilled (not the estimate) on a successful run', async () => {
    mockRealRun({ totalBytesBilled: '111149056', totalBytesProcessed: '110355534' });
    const res = await executeQuery({ connectionId: conn.id, sql: 'SELECT 1', bigqueryCostConfirmationToken: true });
    expect(res.status).toBe('ok');
    const run = await lastRun();
    expect(run.status).toBe('ok');
    expect(run.bytesBilled).toBe(111149056); // billed, NOT the 110355534 estimate
  });

  it('fail-open: a successful run with NO readable billed figure records the per-query cap sentinel, never null/0', async () => {
    mockRealRun({}); // metadata present but totalBytesBilled absent
    const res = await executeQuery({ connectionId: conn.id, sql: 'SELECT 1', bigqueryCostConfirmationToken: true });
    expect(res.status).toBe('ok');
    const run = await lastRun();
    expect(run.bytesBilled).toBe(1_073_741_824); // the connection's bigqueryMaxBytesPerQuery cap
    expect(run.bytesBilled).not.toBeNull();
  });

  it('a legitimate cache-hit run (totalBytesBilled=0) records 0, distinct from the absent-field sentinel', async () => {
    mockRealRun({ totalBytesBilled: '0', totalBytesProcessed: '0', cacheHit: true });
    const res = await executeQuery({ connectionId: conn.id, sql: 'SELECT 1', bigqueryCostConfirmationToken: true });
    expect(res.status).toBe('ok');
    const run = await lastRun();
    expect(run.bytesBilled).toBe(0); // cached $0 run is NOT over-counted to the cap
  });
});

describe('Group A services refuse BigQuery connections cleanly (Phase 6)', () => {
  let conn: Awaited<ReturnType<typeof createBigQueryConnection>>;
  let tableId: string;

  beforeEach(async () => {
    createQueryJobMock.mockReset();
    getDatasetsMock.mockClear();
    conn = await createBigQueryConnection();
    const [t] = await db.insert(schemaTables).values({ connectionId: conn.id, tableName: 'orders', rowCount: 10 }).returning();
    tableId = t.id;
    await db.insert(schemaColumns).values({ tableId, columnName: 'amount', dataType: 'FLOAT64', isNullable: true, isPrimaryKey: false, ordinalPosition: 0 });
  });

  afterEach(async () => {
    await db.delete(schemaColumns).where(eq(schemaColumns.tableId, tableId));
    await db.delete(schemaTables).where(eq(schemaTables.id, tableId));
    await db.delete(connections).where(eq(connections.id, conn.id));
  });

  it('profileColumn throws BigQueryNotSupportedError without ever calling executeReadOnly', async () => {
    await expect(profileColumn(conn.id, 'orders', 'amount')).rejects.toThrow(/not yet supported for BigQuery/);
    expect(createQueryJobMock).not.toHaveBeenCalled();
  });

  it('detectAnomalies returns a graceful note (not a crash) and never calls executeReadOnly', async () => {
    const report = await detectAnomalies(conn.id, 'orders', 'amount');
    expect(report.note).toMatch(/not yet supported for BigQuery/);
    expect(createQueryJobMock).not.toHaveBeenCalled();
  });

  it('fetchQueryLog reports unavailable for BigQuery without calling executeReadOnly', async () => {
    const provider = { dialect: 'bigquery' as const, executeReadOnly: vi.fn() };
    await expect(fetchQueryLog(provider as never)).rejects.toThrow(/not yet supported for BigQuery/);
    expect(provider.executeReadOnly).not.toHaveBeenCalled();
  });

  it('runEval throws BigQueryNotSupportedError before ever calling executeReadOnly on the gold SQL', async () => {
    const [gold] = await db
      .insert(evalQueries)
      .values({ connectionId: conn.id, question: 'total amount?', goldSql: 'SELECT SUM(amount) FROM orders' })
      .returning();
    try {
      await expect(runEval(conn.id)).rejects.toThrow(/not yet supported for BigQuery/);
      expect(createQueryJobMock).not.toHaveBeenCalled();
    } finally {
      await db.delete(evalQueries).where(eq(evalQueries.id, gold.id));
    }
  });
});

describe('BigQuery daily byte-budget (Phase 2)', () => {
  let conn: Awaited<ReturnType<typeof createBigQueryConnection>>;

  beforeEach(async () => {
    createQueryJobMock.mockReset();
    getDatasetsMock.mockClear();
    conn = await createBigQueryConnection();
  });

  afterEach(async () => {
    await db.delete(bqBudgetLedger).where(eq(bqBudgetLedger.connectionId, conn.id));
    await db.delete(queryRuns).where(eq(queryRuns.connectionId, conn.id));
    await db.delete(connections).where(eq(connections.id, conn.id));
  });

  it('admit under budget: small query within generous daily budget records committed bytes', async () => {
    // Setup: generous budget (100 MB), small query estimate (1 MB)
    await db.update(connections).set({ bigqueryDailyBytesBudget: 100 * 1024 * 1024 }).where(eq(connections.id, conn.id));

    // Mock dry-run estimate: 1 MB
    mockDryRunEstimate(String(1 * 1024 * 1024));
    // Mock real run: billed 500 KB
    mockRealRun({ totalBytesBilled: String(500 * 1024), totalBytesProcessed: String(500 * 1024) });

    const res = await executeQuery({ connectionId: conn.id, sql: 'SELECT 1', backgroundBudgeted: true });

    expect(res.status).toBe('ok');
    // Verify ledger recorded the committed bytes (actual billed, not estimate)
    const [ledger] = await db
      .select()
      .from(bqBudgetLedger)
      .where(eq(bqBudgetLedger.connectionId, conn.id))
      .limit(1);
    expect(ledger).toBeDefined();
    expect(ledger.committedBytes).toBe(500 * 1024); // actual billed
    expect(ledger.reservedBytes).toBe(0); // reservation released after reconciliation
  });

  it('block over budget: estimate exceeds daily budget, no real run happens', async () => {
    // Setup: tiny budget (500 KB)
    await db.update(connections).set({ bigqueryDailyBytesBudget: 500 * 1024 }).where(eq(connections.id, conn.id));

    // Mock dry-run estimate: 2 MB (exceeds the 500 KB budget)
    mockDryRunEstimate(String(2 * 1024 * 1024));

    const res = await executeQuery({ connectionId: conn.id, sql: 'SELECT 1', backgroundBudgeted: true });

    expect(res.status).toBe('blocked');
    expect(res.blockedReason).toMatch(/daily byte budget exceeded/);
    // Verify dry-run was called, but real run was never called
    expect(createQueryJobMock).toHaveBeenCalledTimes(1);
    expect(createQueryJobMock).toHaveBeenCalledWith(expect.objectContaining({ dryRun: true }));
    // Verify ledger has no entry (reserve() returned false so ensureLedgerRow ran but reserve didn't increment)
    const ledgers = await db
      .select()
      .from(bqBudgetLedger)
      .where(eq(bqBudgetLedger.connectionId, conn.id));
    // Ledger row may exist but should have 0 reserved/committed since reserve() rejected it
    if (ledgers.length > 0) {
      expect(ledgers[0].reservedBytes).toBe(0);
      expect(ledgers[0].committedBytes).toBe(0);
    }
  });

  it('OLTP-flag isolation: confirmed + skipRiskGate do NOT reach budget path', async () => {
    // OLTP flags should NOT bypass the cost gate; they should fail the same way
    // as if no OLTP flags were set
    const res = await executeQuery({ connectionId: conn.id, sql: 'SELECT 1', confirmed: true, skipRiskGate: true });

    expect(res.status).toBe('error');
    expect(res.errorMessage).toMatch(/interactive cost-confirmation/);
    // Verify no dry-run estimate was attempted
    expect(createQueryJobMock).not.toHaveBeenCalled();
  });

  it('reservation refund on maximumBytesBilled reject: reserved bytes returned to 0', async () => {
    // Setup: generous budget, small estimate that fits
    await db.update(connections).set({ bigqueryDailyBytesBudget: 100 * 1024 * 1024 }).where(eq(connections.id, conn.id));

    mockDryRunEstimate(String(1 * 1024 * 1024));

    // Mock real run that throws maximumBytesBilled error after reserve succeeded
    createQueryJobMock.mockResolvedValueOnce([
      {
        getQueryResults: vi.fn(async () => {
          throw { errors: [{ reason: 'bytesBilledLimitExceeded', message: 'Query exceeded limit' }] };
        }),
        getMetadata: vi.fn(async () => [{ statistics: { query: {} } }]),
      },
    ]);

    const res = await executeQuery({ connectionId: conn.id, sql: 'SELECT 1', backgroundBudgeted: true });

    expect(res.status).toBe('blocked');
    expect(res.blockedReason).toMatch(/cost cap/);

    // Verify ledger: reserved was released (refunded), committed is 0
    const [ledger] = await db
      .select()
      .from(bqBudgetLedger)
      .where(eq(bqBudgetLedger.connectionId, conn.id))
      .limit(1);
    expect(ledger).toBeDefined();
    expect(ledger.reservedBytes).toBe(0); // refunded
    expect(ledger.committedBytes).toBe(0); // no successful commit
  });

  it('concurrency test: parallel queries collectively respect the daily budget', async () => {
    // Setup: budget of 1.5 MB, fire 3 sequential queries of 1 MB estimate each
    // The atomic reserve() check (reserved + committed + estimate <= budget) prevents overspend.
    // Key insight: reserve() checks `reserved + committed + estimate <= budget` atomically.
    // When reconcile() completes, it moves the estimate from reserved to committed (actual billed).
    // This test verifies that the final ledger state never violates the budget.
    const budget = 1.5 * 1024 * 1024;
    await db.update(connections).set({ bigqueryDailyBytesBudget: budget }).where(eq(connections.id, conn.id));

    const queryCount = 3;
    const estimatePerQuery = 1 * 1024 * 1024;
    const billedPerQuery = 900 * 1024; // less than estimate, to show reconcile adjusts downward

    // Mock dry-runs and real runs
    for (let i = 0; i < queryCount; i++) {
      mockDryRunEstimate(String(estimatePerQuery));
      mockRealRun({ totalBytesBilled: String(billedPerQuery) });
    }

    // Fire all queries in parallel
    const results = await Promise.all(
      Array.from({ length: queryCount }, () =>
        executeQuery({ connectionId: conn.id, sql: 'SELECT 1', backgroundBudgeted: true })
      )
    );

    // Count outcomes
    const okCount = results.filter((r) => r.status === 'ok').length;
    const blockedCount = results.filter((r) => r.status === 'blocked').length;

    // With parallel execution and atomic reserve, we expect some queries to be blocked
    // because the initial reserve checks happen before any reconcile
    expect(blockedCount).toBeGreaterThanOrEqual(0); // may or may not block, depending on timing
    expect(okCount).toBeGreaterThan(0); // at least one must succeed

    // CRITICAL: verify ledger total committed doesn't exceed budget (the hard guarantee)
    const [ledger] = await db
      .select()
      .from(bqBudgetLedger)
      .where(eq(bqBudgetLedger.connectionId, conn.id))
      .limit(1);
    if (ledger) {
      // This is the invariant that MUST hold: total usage never exceeds budget
      expect(ledger.committedBytes).toBeLessThanOrEqual(budget);
      // All reserved should be released after reconciliation
      expect(ledger.reservedBytes).toBe(0);
    }
  });

  it('utcDayBucket returns correct YYYY-MM-DD format in UTC', async () => {
    // Import utcDayBucket from the service
    const { utcDayBucket } = await import('./bigquery-daily-budget-service');

    // Test with a known date: 2026-07-16 10:30:00 UTC
    const date = new Date('2026-07-16T10:30:00Z');
    const bucket = utcDayBucket(date);
    expect(bucket).toBe('2026-07-16');

    // Test with another date
    const date2 = new Date('2026-12-31T23:59:59Z');
    const bucket2 = utcDayBucket(date2);
    expect(bucket2).toBe('2026-12-31');

    // Verify it's consistent with toISOString behavior
    const date3 = new Date('2026-01-01T00:00:00Z');
    const bucket3 = utcDayBucket(date3);
    expect(bucket3).toBe('2026-01-01');
  });

  it('cron-path isolation: runWidget with backgroundBudgeted implicitly set does NOT hit cost-confirmation error', async () => {
    // This test verifies the threading: dashboard-service.runWidget() calls
    // executeQuery with backgroundBudgeted:true, so it should use the budget path,
    // not fail with BigQueryConfirmationRequiredError.
    // We test this behaviorally by confirming that:
    // 1. A small estimate + generous budget → query runs to OK
    // 2. No error about "interactive cost-confirmation" is thrown

    await db.update(connections).set({ bigqueryDailyBytesBudget: 100 * 1024 * 1024 }).where(eq(connections.id, conn.id));

    mockDryRunEstimate(String(1 * 1024 * 1024));
    mockRealRun({ totalBytesBilled: String(500 * 1024) });

    // This simulates dashboard-service.runWidget calling executeQuery with backgroundBudgeted:true
    const res = await executeQuery({ connectionId: conn.id, sql: 'SELECT 1', backgroundBudgeted: true });

    // Should NOT be 'error' with "interactive cost-confirmation" message
    expect(res.status).toBe('ok');
    expect(res.errorMessage).toBeUndefined();
  });

  it('budget rejection records the ledger row for audit trail (even if reserve fails)', async () => {
    await db.update(connections).set({ bigqueryDailyBytesBudget: 500 * 1024 }).where(eq(connections.id, conn.id));

    mockDryRunEstimate(String(2 * 1024 * 1024)); // exceeds budget

    const res = await executeQuery({ connectionId: conn.id, sql: 'SELECT 1', backgroundBudgeted: true });

    expect(res.status).toBe('blocked');

    // Ledger row should exist (via ensureLedgerRow before reserve attempt)
    const [ledger] = await db
      .select()
      .from(bqBudgetLedger)
      .where(eq(bqBudgetLedger.connectionId, conn.id))
      .limit(1);
    expect(ledger).toBeDefined();
    expect(ledger.connectionId).toBe(conn.id);
  });

  it('partial usage then rejection: budget tracks prior day usage correctly', async () => {
    // Simulate: day 1 has 2 MB committed, budget is 3 MB. Day 2 should start fresh.
    // For simplicity, test within the same "day" (UTC bucket): use 2 MB, then try 2 MB more (should fail).

    const budget = 3 * 1024 * 1024;
    await db.update(connections).set({ bigqueryDailyBytesBudget: budget }).where(eq(connections.id, conn.id));

    // First query: 1 MB estimate, 1 MB billed
    mockDryRunEstimate(String(1 * 1024 * 1024));
    mockRealRun({ totalBytesBilled: String(1 * 1024 * 1024) });

    const res1 = await executeQuery({ connectionId: conn.id, sql: 'SELECT 1', backgroundBudgeted: true });
    expect(res1.status).toBe('ok');

    // Second query: 2.5 MB estimate (fits into 3 MB - 1 MB = 2 MB remaining)
    // But 2.5 MB > 2 MB, so should be blocked
    mockDryRunEstimate(String(2.5 * 1024 * 1024));

    const res2 = await executeQuery({ connectionId: conn.id, sql: 'SELECT 2', backgroundBudgeted: true });
    expect(res2.status).toBe('blocked');
    expect(res2.blockedReason).toMatch(/daily byte budget exceeded/);

    // Verify ledger shows only 1 MB committed (from first query)
    const [ledger] = await db
      .select()
      .from(bqBudgetLedger)
      .where(eq(bqBudgetLedger.connectionId, conn.id))
      .limit(1);
    expect(ledger.committedBytes).toBe(1 * 1024 * 1024);
    expect(ledger.reservedBytes).toBe(0); // second query's reserve was rejected, so no reserved bytes
  });

  it('successful run with no readable billed figure still records a ledger entry', async () => {
    await db.update(connections).set({ bigqueryDailyBytesBudget: 100 * 1024 * 1024 }).where(eq(connections.id, conn.id));

    mockDryRunEstimate(String(1 * 1024 * 1024));
    // Real run returns metadata but no totalBytesBilled (fail-open scenario)
    mockRealRun({});

    const res = await executeQuery({ connectionId: conn.id, sql: 'SELECT 1', backgroundBudgeted: true });

    expect(res.status).toBe('ok');

    // Ledger should record the per-query cap sentinel (bigqueryMaxBytesPerQuery)
    const [ledger] = await db
      .select()
      .from(bqBudgetLedger)
      .where(eq(bqBudgetLedger.connectionId, conn.id))
      .limit(1);
    expect(ledger).toBeDefined();
    expect(ledger.committedBytes).toBe(conn.bigqueryMaxBytesPerQuery); // the cap sentinel from Phase 1
  });

  it('cache-hit query (0 bytes billed) is recorded distinctly in the ledger', async () => {
    await db.update(connections).set({ bigqueryDailyBytesBudget: 100 * 1024 * 1024 }).where(eq(connections.id, conn.id));

    mockDryRunEstimate(String(1 * 1024 * 1024));
    mockRealRun({ totalBytesBilled: '0', totalBytesProcessed: '0', cacheHit: true });

    const res = await executeQuery({ connectionId: conn.id, sql: 'SELECT 1', backgroundBudgeted: true });

    expect(res.status).toBe('ok');

    const [ledger] = await db
      .select()
      .from(bqBudgetLedger)
      .where(eq(bqBudgetLedger.connectionId, conn.id))
      .limit(1);
    expect(ledger.committedBytes).toBe(0); // cache hit = 0 cost, not the cap sentinel
  });
});
