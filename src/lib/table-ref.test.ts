import { describe, it, expect } from 'vitest';
import { qualifiedTableRef, quoteColumn } from './table-ref';

describe('qualifiedTableRef', () => {
  it('qualifies BigQuery with its dataset (dataset.table, backtick-quoted)', () => {
    expect(qualifiedTableRef('bigquery', 'usa_1910_2013', 'usa_names')).toBe('`usa_names`.`usa_1910_2013`');
  });

  it('BigQuery without a dataset falls back to a bare backtick ref', () => {
    expect(qualifiedTableRef('bigquery', 'orders', null)).toBe('`orders`');
    expect(qualifiedTableRef('bigquery', 'orders', undefined)).toBe('`orders`');
  });

  it('OLTP dialects keep the historical BARE quoted name (schema ignored — resolved by default schema)', () => {
    expect(qualifiedTableRef('postgres', 'orders', 'public')).toBe('"orders"');
    expect(qualifiedTableRef('sqlite', 'orders', null)).toBe('"orders"');
    expect(qualifiedTableRef('mssql', 'orders', 'dbo')).toBe('[orders]');
    expect(qualifiedTableRef('mysql', 'orders', 'db')).toBe('`orders`');
  });

  it('strips unsafe characters from identifiers', () => {
    expect(qualifiedTableRef('bigquery', 'or;ders--', 'da/ta set')).toBe('`dataset`.`orders`');
    expect(qualifiedTableRef('postgres', 'orders"; DROP', null)).toBe('"ordersDROP"');
  });
});

describe('quoteColumn', () => {
  it('backtick-quotes for BigQuery and MySQL, double-quotes otherwise; never dataset-qualified', () => {
    expect(quoteColumn('bigquery', 'amount')).toBe('`amount`');
    expect(quoteColumn('mysql', 'amount')).toBe('`amount`');
    expect(quoteColumn('postgres', 'amount')).toBe('"amount"');
    expect(quoteColumn('sqlite', 'amount')).toBe('"amount"');
  });

  it('strips unsafe characters', () => {
    expect(quoteColumn('postgres', 'a; DROP')).toBe('"aDROP"');
  });
});
