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
import { connections } from '../db/schema';
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
import { schemaTables, schemaColumns } from '../db/schema';
import { evalQueries } from '../db/intelligence-schema';

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
