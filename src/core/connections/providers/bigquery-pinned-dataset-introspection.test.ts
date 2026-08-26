import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * A BigQuery connection can only ever *list* the datasets its own project holds.
 * A dataset shared in from another project — a public catalog, a partner's prod
 * project — is invisible to that listing, so a connection pointed at an empty
 * analytics project introspects to nothing even though the data it exists to
 * query is one grant away.
 *
 * These tests cover the pinning path that closes that gap, and the identity it
 * has to record: which project actually owns each dataset, kept in its own
 * field. The project must never be folded into schemaName — scope matching
 * compares dataset-only names, so a project-prefixed entry would match nothing —
 * and that separation is what the assertions here hold in place.
 */

type FakeTable = { id: string; getMetadata: () => Promise<[Record<string, unknown>]> };

function fakeTable(id: string, fields: { name: string; type: string }[], numRows: number): FakeTable {
  return {
    id,
    getMetadata: async () => [{ numRows: String(numRows), schema: { fields } }],
  };
}

/** Datasets the project itself owns — what getDatasets() returns. */
const ownDatasets: unknown[] = [];
/** Datasets reachable only by naming them: keyed `project.dataset`. */
const externalDatasets = new Map<string, unknown>();

const getDatasetsMock = vi.fn(async () => [ownDatasets]);
const datasetMock = vi.fn((id: string, opts?: { projectId?: string }) => {
  const key = `${opts?.projectId ?? 'test-project'}.${id}`;
  return (
    externalDatasets.get(key) ?? {
      id,
      projectId: opts?.projectId,
      getTables: async () => {
        throw new Error('Not found: Dataset');
      },
    }
  );
});

vi.mock('@google-cloud/bigquery', () => {
  class BigQuery {
    getDatasets = getDatasetsMock;
    dataset = datasetMock;
    createQueryJob = vi.fn();
  }
  return { BigQuery };
});

import { BigQueryConnectionProvider } from '@/core/connections/providers/bigquery-provider';

function makeProvider(extraDatasets?: string[]) {
  return new BigQueryConnectionProvider({
    projectId: 'test-project',
    credentials: { client_email: 'sa@test.iam.gserviceaccount.com', private_key: 'fake' },
    maximumBytesBilled: 1_073_741_824,
    extraDatasets,
  });
}

function stubDataset(projectId: string, id: string, tables: FakeTable[]) {
  return { id, projectId, getTables: async () => [tables] };
}

describe('BigQuery introspection of pinned cross-project datasets', () => {
  beforeEach(() => {
    ownDatasets.length = 0;
    externalDatasets.clear();
    getDatasetsMock.mockClear();
    datasetMock.mockClear();
  });

  it('records the owning project of the connection\'s own datasets', async () => {
    ownDatasets.push(
      stubDataset('test-project', 'sales', [fakeTable('orders', [{ name: 'id', type: 'INT64' }], 42)]),
    );

    const { tables } = await makeProvider().introspectSchema();

    expect(tables).toEqual([
      { schemaName: 'sales', catalogName: 'test-project', tableName: 'orders', rowCount: 42 },
    ]);
  });

  it('introspects a dataset from another project when it is pinned', async () => {
    externalDatasets.set(
      'bigquery-public-data.thelook_ecommerce',
      stubDataset('bigquery-public-data', 'thelook_ecommerce', [
        fakeTable('orders', [{ name: 'order_id', type: 'INT64' }, { name: 'status', type: 'STRING' }], 181759),
      ]),
    );

    const provider = makeProvider(['bigquery-public-data.thelook_ecommerce']);
    const { tables, columns } = await provider.introspectSchema();

    expect(datasetMock).toHaveBeenCalledWith('thelook_ecommerce', { projectId: 'bigquery-public-data' });
    expect(tables).toEqual([
      {
        schemaName: 'thelook_ecommerce',
        catalogName: 'bigquery-public-data',
        tableName: 'orders',
        rowCount: 181759,
      },
    ]);
    // Columns land with the same dataset-only schemaName as the table row, so the
    // two join on the key the sync service builds.
    expect(columns.map((c) => [c.schemaName, c.tableName, c.columnName])).toEqual([
      ['thelook_ecommerce', 'orders', 'order_id'],
      ['thelook_ecommerce', 'orders', 'status'],
    ]);
  });

  it('never puts the project into schemaName — scope matching compares dataset-only names', async () => {
    externalDatasets.set(
      'bigquery-public-data.thelook_ecommerce',
      stubDataset('bigquery-public-data', 'thelook_ecommerce', [fakeTable('users', [], 100)]),
    );

    const { tables } = await makeProvider(['bigquery-public-data.thelook_ecommerce']).introspectSchema();

    expect(tables[0].schemaName).toBe('thelook_ecommerce');
    expect(tables[0].schemaName).not.toContain('.');
    expect(tables[0].schemaName).not.toContain('bigquery-public-data');
  });

  it('skips a pinned dataset the service account cannot read, without failing the sync', async () => {
    ownDatasets.push(stubDataset('test-project', 'sales', [fakeTable('orders', [], 1)]));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    // 'nope.forbidden' is absent from externalDatasets, so getTables() throws.
    const { tables } = await makeProvider(['nope.forbidden']).introspectSchema();

    expect(tables.map((t) => t.tableName)).toEqual(['orders']);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('ignores a malformed pinned entry instead of building a broken dataset ref', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const { tables } = await makeProvider(['no-dot-here']).introspectSchema();

    expect(tables).toEqual([]);
    expect(datasetMock).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('no-dot-here'));
    warn.mockRestore();
  });

  it('does not introspect a pinned dataset twice when the own-project sweep already found it', async () => {
    ownDatasets.push(stubDataset('test-project', 'sales', [fakeTable('orders', [], 7)]));

    const { tables } = await makeProvider(['test-project.sales']).introspectSchema();

    expect(tables).toHaveLength(1);
    expect(datasetMock).not.toHaveBeenCalled();
  });
});
