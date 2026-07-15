import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockDatasets: unknown[] = [];
const getDatasetsMock = vi.fn(async () => [mockDatasets]);
const createQueryJobMock = vi.fn();

vi.mock('@google-cloud/bigquery', () => {
  class BigQuery {
    getDatasets = getDatasetsMock;
    createQueryJob = createQueryJobMock;
  }
  return { BigQuery };
});

import {
  BigQueryConnectionProvider,
  sanitizeBigQueryConnError,
  EstimateFailedError,
  MaximumBytesBilledExceededError,
} from './bigquery-provider';
import { assessRisk } from '../risk-scoring-service';

function makeProvider() {
  return new BigQueryConnectionProvider({
    projectId: 'test-project',
    credentials: { client_email: 'sa@test.iam.gserviceaccount.com', private_key: 'fake' },
    maximumBytesBilled: 1_073_741_824,
  });
}

describe('BigQueryConnectionProvider', () => {
  beforeEach(() => {
    mockDatasets.length = 0;
    getDatasetsMock.mockClear();
    createQueryJobMock.mockReset();
  });

  it('throws at construction when maximumBytesBilled is missing/zero (fail closed, never uncapped)', () => {
    expect(() => new BigQueryConnectionProvider({
      projectId: 'test-project',
      credentials: {},
      maximumBytesBilled: 0,
    })).toThrow(/maximumBytesBilled/);
    expect(() => new BigQueryConnectionProvider({
      projectId: 'test-project',
      credentials: {},
      // @ts-expect-error deliberately omitting the required field
      maximumBytesBilled: undefined,
    })).toThrow(/maximumBytesBilled/);
  });

  it('probeWritePrivilege always reports read-only, without a live probe', async () => {
    const provider = makeProvider();
    const probe = await provider.probeWritePrivilege();
    expect(probe.isReadOnly).toBe(true);
    expect(probe.detail).toMatch(/dataViewer/);
  });

  it('explainQuery throws (BigQuery uses dry-run cost estimate instead of EXPLAIN)', async () => {
    const provider = makeProvider();
    await expect(provider.explainQuery('SELECT 1')).rejects.toThrow(/NotImplemented/);
  });

  it('introspectSchema maps datasets/tables/columns and tolerates a per-dataset access error', async () => {
    const okTable = {
      id: 'orders',
      getMetadata: vi.fn(async () => [{
        numRows: '42',
        schema: { fields: [{ name: 'id', type: 'INT64', mode: 'REQUIRED' }, { name: 'note', type: 'STRING' }] },
      }]),
    };
    const okDataset = { id: 'sales', getTables: vi.fn(async () => [[okTable]]) };
    const deniedDataset = { id: 'restricted', getTables: vi.fn(async () => { throw new Error('Access Denied: Dataset restricted'); }) };
    mockDatasets.push(okDataset, deniedDataset);

    const provider = makeProvider();
    const schema = await provider.introspectSchema();

    expect(schema.tables).toEqual([{ schemaName: 'sales', tableName: 'orders', rowCount: 42 }]);
    expect(schema.columns).toEqual([
      { tableName: 'orders', schemaName: 'sales', columnName: 'id', dataType: 'INT64', isNullable: false, isPrimaryKey: false, ordinalPosition: 0 },
      { tableName: 'orders', schemaName: 'sales', columnName: 'note', dataType: 'STRING', isNullable: true, isPrimaryKey: false, ordinalPosition: 1 },
    ]);
    expect(schema.foreignKeys).toEqual([]);
    // The restricted dataset was skipped, not thrown — introspection succeeded overall.
    expect(deniedDataset.getTables).toHaveBeenCalled();
  });

  it('testConnection routes a thrown auth error through sanitizeBigQueryConnError', async () => {
    getDatasetsMock.mockRejectedValueOnce(new Error('invalid_grant: reauth related error, client_email=sa@test.iam.gserviceaccount.com'));
    const provider = makeProvider();
    await expect(provider.testConnection()).rejects.toThrow(/BigQuery authentication failed/);
  });

  it('estimateCost returns a sane estimate from a dry-run job, at $0/no billed bytes consumed', async () => {
    createQueryJobMock.mockResolvedValueOnce([
      { metadata: { statistics: { query: { totalBytesProcessed: String(2 * 1024 ** 4) } } } }, // 2 TiB
    ]);
    const provider = makeProvider();
    const estimate = await provider.estimateCost('SELECT * FROM `test-project.sales.orders`');
    expect(estimate.estimatedBytes).toBe(2 * 1024 ** 4);
    expect(estimate.estimatedCostUsd).toBeCloseTo(12.5, 5); // 2 TiB * $6.25/TiB
    expect(estimate.reliable).toBe(true);
    // dry-run job config, never a real execution.
    expect(createQueryJobMock).toHaveBeenCalledWith(expect.objectContaining({ dryRun: true }));
  });

  it('estimateCost reports reliable:false when totalBytesProcessed is 0 for a non-trivial query', async () => {
    createQueryJobMock.mockResolvedValueOnce([
      { metadata: { statistics: { query: { totalBytesProcessed: '0' } } } },
    ]);
    const provider = makeProvider();
    const estimate = await provider.estimateCost('SELECT * FROM `test-project.sales.orders`');
    expect(estimate.estimatedBytes).toBe(0);
    expect(estimate.reliable).toBe(false);
  });

  it('estimateCost treats a non-numeric totalBytesProcessed as 0 bytes rather than propagating NaN into the cost figure', async () => {
    createQueryJobMock.mockResolvedValueOnce([
      { metadata: { statistics: { query: { totalBytesProcessed: 'not-a-number' } } } },
    ]);
    const provider = makeProvider();
    const estimate = await provider.estimateCost('SELECT * FROM `test-project.sales.orders`');
    expect(estimate.estimatedBytes).toBe(0);
    expect(estimate.estimatedCostUsd).toBe(0.01);
    expect(Number.isNaN(estimate.estimatedCostUsd)).toBe(false);
    expect(estimate.reliable).toBe(false);
  });

  it('estimateCost throws EstimateFailedError (not a generic error, not a silent pass) when the dry-run job itself fails', async () => {
    createQueryJobMock.mockRejectedValueOnce(new Error('Syntax error: Unexpected end of script'));
    const provider = makeProvider();
    await expect(provider.estimateCost('SELECT * FROM')).rejects.toBeInstanceOf(EstimateFailedError);
  });

  it('executeReadOnly sets maximumBytesBilled from constructor-injected state, never a per-call option', async () => {
    createQueryJobMock.mockResolvedValueOnce([
      { getQueryResults: vi.fn(async () => [[]]), getMetadata: vi.fn(async () => [{ statistics: { query: {} } }]) },
    ]);
    const provider = new BigQueryConnectionProvider({
      projectId: 'test-project',
      credentials: {},
      maximumBytesBilled: 500_000_000,
    });
    await provider.executeReadOnly('SELECT 1');
    expect(createQueryJobMock).toHaveBeenCalledWith(expect.objectContaining({ maximumBytesBilled: '500000000' }));
  });

  it('executeReadOnly throws MaximumBytesBilledExceededError (distinct from a generic crash) when BigQuery rejects the job for exceeding the cap', async () => {
    // Real shape captured 2026-07-16 against a live BigQuery project (see
    // scripts/verify-bigquery-cost-cap.ts) — the client throws an Error whose
    // `errors[0].reason` is `bytesBilledLimitExceeded`, not a message-string match.
    const rejection = Object.assign(
      new Error('Query exceeded limit for bytes billed: 85716253. 171966464 or higher required.'),
      { errors: [{ reason: 'bytesBilledLimitExceeded', message: 'Query exceeded limit for bytes billed: 85716253. 171966464 or higher required.' }] },
    );
    createQueryJobMock.mockRejectedValueOnce(rejection);
    const provider = makeProvider();
    await expect(provider.executeReadOnly('SELECT * FROM `test-project.sales.orders`'))
      .rejects.toBeInstanceOf(MaximumBytesBilledExceededError);
  });

  it('executeReadOnly does NOT misclassify an unrelated error as MaximumBytesBilledExceededError', async () => {
    createQueryJobMock.mockRejectedValueOnce(new Error('Not Found: Table nope'));
    const provider = makeProvider();
    await expect(provider.executeReadOnly('SELECT * FROM `test-project.sales.orders`'))
      .rejects.not.toBeInstanceOf(MaximumBytesBilledExceededError);
  });
});

describe('sanitizeBigQueryConnError', () => {
  it('replaces auth-related errors with a generic message (no credential leakage)', () => {
    const msg = sanitizeBigQueryConnError(new Error('invalid_grant: private_key is malformed for client_email=sa@x.iam.gserviceaccount.com'));
    expect(msg).not.toContain('client_email');
    expect(msg).not.toContain('private_key');
    expect(msg).toMatch(/BigQuery authentication failed/);
  });

  it('passes through unrelated errors unchanged', () => {
    expect(sanitizeBigQueryConnError(new Error('Not Found: Table nope'))).toBe('Not Found: Table nope');
  });
});

describe('risk-scoring-service integration with BigQuery', () => {
  it('assessRisk escalates to medium tier when explainQuery throws (BigQuery path)', async () => {
    const provider = makeProvider();
    const assessment = await assessRisk(provider, 'SELECT * FROM `test-project.sales.orders`');
    expect(assessment.tier).toBe('medium');
    expect(assessment.reason).toMatch(/Could not estimate cost/);
  });
});
