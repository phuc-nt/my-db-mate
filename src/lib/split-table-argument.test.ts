import { describe, it, expect } from 'vitest';
import { splitTableArgument } from './split-table-argument';

/**
 * The model is told to copy table names out of the schema listing verbatim, and
 * that listing spells out the owning project when a BigQuery dataset belongs to
 * another one. So the argument arrives in whichever shape the listing used, and
 * only the last two parts identify a synced row.
 */
describe('splitTableArgument', () => {
  it('keeps the dataset and drops the project from a three-part name', () => {
    expect(splitTableArgument('bigquery-public-data.thelook_ecommerce.orders')).toEqual({
      dataset: 'thelook_ecommerce',
      table: 'orders',
    });
  });

  it('splits a two-part name into its dataset and table', () => {
    expect(splitTableArgument('thelook_ecommerce.orders')).toEqual({
      dataset: 'thelook_ecommerce',
      table: 'orders',
    });
  });

  it('reports no dataset for a bare name, leaving the lookup unqualified', () => {
    expect(splitTableArgument('orders')).toEqual({ dataset: '', table: 'orders' });
  });

  it('strips characters an identifier cannot hold, per part', () => {
    // The dots are consumed by the split, so sanitizing can no longer fuse the
    // dataset and table into one token the way stripping-then-splitting would.
    expect(splitTableArgument('the look;.or ders')).toEqual({ dataset: 'thelook', table: 'orders' });
  });

  it('does not let a hyphenated project bleed into the dataset', () => {
    // The regression this helper exists for: splitting on the LAST dot alone left
    // `bigquery-public-data.thelook_ecommerce` as the dataset, which sanitized
    // down to `bigquerypublicdatathelook_ecommerce` and matched no synced row.
    const { dataset } = splitTableArgument('bigquery-public-data.thelook_ecommerce.orders');
    expect(dataset).toBe('thelook_ecommerce');
    expect(dataset).not.toContain('bigquery');
  });

  it('takes the last two parts when a name is qualified beyond three', () => {
    expect(splitTableArgument('a.b.c.dataset.table')).toEqual({ dataset: 'dataset', table: 'table' });
  });
});
