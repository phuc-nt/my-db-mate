import { describe, it, expect } from 'vitest';
import { composeSchemaPrefix } from './table-catalog-prefix';
import { qualifiedTableRef } from './table-ref';
import { extractScopeRefs } from './sql-scope-refs';

/**
 * The catalog (BigQuery: project) is attached to a table reference here, at
 * render time, and nowhere else. The tests below hold both halves of that rule:
 * the reference the warehouse needs gets built, and the stored `schemaName` the
 * scope guard compares against stays dataset-only.
 */
describe('composeSchemaPrefix', () => {
  it('attaches the owning project to a BigQuery dataset', () => {
    expect(composeSchemaPrefix('bigquery', 'bigquery-public-data', 'thelook_ecommerce')).toBe(
      'bigquery-public-data.thelook_ecommerce',
    );
  });

  it('leaves the dataset alone when no catalog was recorded', () => {
    // Rows synced before catalogs were persisted, and every non-BigQuery engine.
    expect(composeSchemaPrefix('bigquery', null, 'sales')).toBe('sales');
    expect(composeSchemaPrefix('bigquery', undefined, 'sales')).toBe('sales');
  });

  it('ignores a catalog on a dialect that has no catalog level', () => {
    expect(composeSchemaPrefix('postgres', 'some-project', 'public')).toBe('public');
    expect(composeSchemaPrefix('mysql', 'some-project', 'app')).toBe('app');
    expect(composeSchemaPrefix('duckdb', 'some-project', 'main')).toBe('main');
  });

  it('passes a missing schema straight through', () => {
    expect(composeSchemaPrefix('bigquery', 'proj', null)).toBeNull();
    expect(composeSchemaPrefix('postgres', null, undefined)).toBeNull();
  });

  it('does not attach a second catalog to an already-qualified prefix', () => {
    expect(composeSchemaPrefix('bigquery', 'other-project', 'bigquery-public-data.thelook_ecommerce')).toBe(
      'bigquery-public-data.thelook_ecommerce',
    );
  });
});

describe('the reference the composed prefix produces', () => {
  it('renders a three-part BigQuery ref, each part quoted', () => {
    const prefix = composeSchemaPrefix('bigquery', 'bigquery-public-data', 'thelook_ecommerce');
    expect(qualifiedTableRef('bigquery', 'orders', prefix)).toBe(
      '`bigquery-public-data`.`thelook_ecommerce`.`orders`',
    );
  });

  it('falls back to the two-part ref when there is no catalog', () => {
    const prefix = composeSchemaPrefix('bigquery', null, 'thelook_ecommerce');
    expect(qualifiedTableRef('bigquery', 'orders', prefix)).toBe('`thelook_ecommerce`.`orders`');
  });

  it('leaves other dialects byte-for-byte unchanged', () => {
    expect(qualifiedTableRef('postgres', 'orders', composeSchemaPrefix('postgres', 'p', 'public'))).toBe('"orders"');
    expect(qualifiedTableRef('mysql', 'orders', composeSchemaPrefix('mysql', 'p', 'app'))).toBe('`orders`');
  });
});

describe('a catalog-qualified reference still resolves against the governed scope', () => {
  /**
   * The whole reason the project lives in its own column: the SQL parser reports
   * the second-to-last dotted part as the schema, so a scope entry holding a
   * project-prefixed name would match nothing at all. Scope entries stay
   * dataset-only, and a three-part reference in the model's SQL still lands on
   * them.
   */
  it('parses a three-part name down to its dataset, not its project', () => {
    const prefix = composeSchemaPrefix('bigquery', 'bigquery-public-data', 'thelook_ecommerce');
    const sql = `SELECT * FROM ${qualifiedTableRef('bigquery', 'orders', prefix)}`;

    const refs = extractScopeRefs(sql, 'bigquery');

    expect(refs).toEqual([{ schemaName: 'thelook_ecommerce', tableName: 'orders' }]);
    // A null here would mean the parser gave up on the statement — the guard
    // fails closed in that case, but it would also mean this test proved nothing.
    expect(refs?.[0].schemaName).not.toContain('bigquery-public-data');
  });
});
