import { describe, it, expect } from 'vitest';
import { isRefInScope, filterTablesToScope, isScopeActive, type SchemaScope } from '@/core/boundary/schema-scope-service';

const ref = (schemaName: string | null, tableName: string) => ({ schemaName, tableName });

describe('isScopeActive', () => {
  it('treats null and undefined as unscoped', () => {
    expect(isScopeActive(null)).toBe(false);
    expect(isScopeActive(undefined)).toBe(false);
  });

  it('treats an empty scope as unscoped so a half-filled form cannot lock the user out', () => {
    expect(isScopeActive({})).toBe(false);
    expect(isScopeActive({ datasets: [], tables: [] })).toBe(false);
  });

  it('is active once anything is listed', () => {
    expect(isScopeActive({ datasets: ['marts'] })).toBe(true);
    expect(isScopeActive({ tables: ['marts.orders'] })).toBe(true);
  });

  it('is not active on viewsOnly alone (Phase 2 flag, not a table boundary)', () => {
    expect(isScopeActive({ viewsOnly: true })).toBe(false);
  });
});

describe('isRefInScope — dataset-level grants', () => {
  const scope: SchemaScope = { datasets: ['marts_sales'] };

  it('admits any table in a granted dataset', () => {
    expect(isRefInScope(scope, ref('marts_sales', 'orders'))).toBe(true);
    expect(isRefInScope(scope, ref('marts_sales', 'anything_else'))).toBe(true);
  });

  it('rejects the same table name in another dataset', () => {
    expect(isRefInScope(scope, ref('raw_events', 'orders'))).toBe(false);
  });

  it('rejects an unqualified reference when only datasets are granted', () => {
    expect(isRefInScope(scope, ref(null, 'orders'))).toBe(false);
  });

  it('matches dataset names case-insensitively', () => {
    expect(isRefInScope(scope, ref('MARTS_SALES', 'Orders'))).toBe(true);
  });
});

describe('isRefInScope — table-level grants', () => {
  it('admits a qualified table listed in qualified form', () => {
    const scope: SchemaScope = { tables: ['marts_sales.orders'] };
    expect(isRefInScope(scope, ref('marts_sales', 'orders'))).toBe(true);
    expect(isRefInScope(scope, ref('marts_sales', 'customers'))).toBe(false);
  });

  it('admits a bare table name for dialects that leave the schema implicit', () => {
    const scope: SchemaScope = { tables: ['orders'] };
    expect(isRefInScope(scope, ref(null, 'orders'))).toBe(true);
    expect(isRefInScope(scope, ref(null, 'customers'))).toBe(false);
  });

  it('admits a qualified reference whose bare name is listed', () => {
    // Sync stores bare names on SQLite/MySQL; a query may still qualify them.
    const scope: SchemaScope = { tables: ['orders'] };
    expect(isRefInScope(scope, ref('main', 'orders'))).toBe(true);
  });
});

describe('isRefInScope — BigQuery specifics', () => {
  it('admits INFORMATION_SCHEMA when its dataset is in scope', () => {
    const scope: SchemaScope = { datasets: ['marts_sales'] };
    expect(isRefInScope(scope, ref('marts_sales', 'INFORMATION_SCHEMA.TABLES'))).toBe(true);
  });

  it('rejects INFORMATION_SCHEMA of a dataset outside the scope', () => {
    const scope: SchemaScope = { datasets: ['marts_sales'] };
    expect(isRefInScope(scope, ref('raw_events', 'INFORMATION_SCHEMA.TABLES'))).toBe(false);
  });

  it('admits a wildcard shard family when its dataset is granted', () => {
    const scope: SchemaScope = { datasets: ['raw_events'] };
    expect(isRefInScope(scope, ref('raw_events', 'events_*'))).toBe(true);
  });

  it('rejects a wildcard family whose dataset is not granted', () => {
    const scope: SchemaScope = { datasets: ['marts_sales'] };
    expect(isRefInScope(scope, ref('raw_events', 'events_*'))).toBe(false);
  });

  it('admits concrete shards covered by a listed wildcard family', () => {
    const scope: SchemaScope = { tables: ['raw_events.events_*'] };
    expect(isRefInScope(scope, ref('raw_events', 'events_20260101'))).toBe(true);
    expect(isRefInScope(scope, ref('raw_events', 'sessions'))).toBe(false);
  });

  it('admits a wildcard reference matching a listed family', () => {
    const scope: SchemaScope = { tables: ['raw_events.events_*'] };
    expect(isRefInScope(scope, ref('raw_events', 'events_*'))).toBe(true);
  });
});

describe('filterTablesToScope', () => {
  const tables = [
    { schemaName: 'marts_sales', tableName: 'orders' },
    { schemaName: 'marts_sales', tableName: 'customers' },
    { schemaName: 'raw_events', tableName: 'clicks' },
  ];

  it('passes every table through when the connection is unscoped', () => {
    expect(filterTablesToScope(null, tables)).toHaveLength(3);
    expect(filterTablesToScope({}, tables)).toHaveLength(3);
  });

  it('keeps only the granted dataset', () => {
    const kept = filterTablesToScope({ datasets: ['marts_sales'] }, tables);
    expect(kept.map((t) => t.tableName).sort()).toEqual(['customers', 'orders']);
  });

  it('keeps only the granted table', () => {
    const kept = filterTablesToScope({ tables: ['marts_sales.orders'] }, tables);
    expect(kept.map((t) => t.tableName)).toEqual(['orders']);
  });
});
