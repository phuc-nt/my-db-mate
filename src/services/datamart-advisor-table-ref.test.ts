/**
 * How a table is spelled for the model, and why the project id stops at the prompt.
 *
 * BigQuery resolves an unqualified name against the connection's own project, so
 * a dataset shared from elsewhere — every `bigquery-public-data` dataset, and any
 * cross-project grant — needs its project spelled out or the query fails with
 * "Dataset ... was not found". The obvious fix, storing the qualified name on the
 * table row, would quietly break governance instead: the scope guard compares
 * against what the SQL parser reports, and the parser reports the dataset alone.
 * So the project is attached at render time only, and the last test here holds
 * that line — it is the one that stops a future refactor from moving the join.
 */
import { describe, expect, it } from 'vitest';
import { advisorPromptTableRef, advisorQualifiedName } from './datamart-advisor-service';
import { extractScopeRefs } from '../lib/sql-scope-refs';
import { isRefInScope } from '@/core/boundary/schema-scope-service';

describe('the table reference handed to the model', () => {
  it('spells out the owning project on BigQuery', () => {
    expect(advisorPromptTableRef('bigquery', 'bigquery-public-data', 'thelook_ecommerce', 'orders'))
      .toBe('bigquery-public-data.thelook_ecommerce.orders');
  });

  it('falls back to the bare dataset when the project could not be resolved', () => {
    expect(advisorPromptTableRef('bigquery', null, 'thelook_ecommerce', 'orders'))
      .toBe('thelook_ecommerce.orders');
  });

  it('does not double-qualify a name that already carries a project', () => {
    expect(advisorPromptTableRef('bigquery', 'proj', 'bigquery-public-data.thelook_ecommerce', 'orders'))
      .toBe('bigquery-public-data.thelook_ecommerce.orders');
  });

  it.each([
    ['postgres' as const, 'public', 'orders', 'public.orders'],
    ['mysql' as const, 'shop', 'orders', 'shop.orders'],
    ['sqlite' as const, null, 'orders', 'orders'],
  ])('leaves %s alone', (dialect, schema, table, expected) => {
    expect(advisorPromptTableRef(dialect, 'some-project', schema, table)).toBe(expected);
    expect(advisorQualifiedName(schema, table)).toBe(expected);
  });

  /**
   * The reason the project may not be stored. A scope entry holding the
   * three-part name matches nothing, because `extractScopeRefs` reports the
   * dataset as the schema no matter how many parts the ref has. Storing the
   * qualified form would therefore lock the agent out of every table it is
   * supposed to be allowed to read — governance failing shut, silently.
   */
  it('would break scope matching if the project were stored instead of rendered', () => {
    const refs = extractScopeRefs('SELECT * FROM `bigquery-public-data.thelook_ecommerce.orders`', 'bigquery');
    expect(refs).not.toBeNull();
    const ref = refs![0];
    expect(ref.schemaName).toBe('thelook_ecommerce');

    const storedQualified = { tables: ['bigquery-public-data.thelook_ecommerce.orders'] };
    const storedBare = { tables: ['thelook_ecommerce.orders'] };
    expect(isRefInScope(storedQualified, ref)).toBe(false);
    expect(isRefInScope(storedBare, ref)).toBe(true);
  });
});
