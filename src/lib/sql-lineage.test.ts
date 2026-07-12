import { describe, expect, it } from 'vitest';
import { extractLineage } from './sql-lineage';

describe('extractLineage', () => {
  it('simple select with where + group by', () => {
    const l = extractLineage("SELECT ord_sts_cd, COUNT(*) FROM orders WHERE order_date >= '2026-01-01' GROUP BY ord_sts_cd", 'sqlite');
    expect(l?.tables).toEqual(['orders']);
    expect(l?.whereColumns).toContain('order_date');
    expect(l?.groupBy).toContain('ord_sts_cd');
  });

  it('join collects both tables', () => {
    const l = extractLineage('SELECT c.name, SUM(o.total_amt) FROM orders o JOIN customers c ON c.id = o.customer_id GROUP BY c.name', 'postgres');
    expect(l?.tables?.sort()).toEqual(['customers', 'orders']);
  });

  it('no where/group → empty arrays', () => {
    const l = extractLineage('SELECT * FROM products', 'mysql');
    expect(l).toEqual({ tables: ['products'], whereColumns: [], groupBy: [] });
  });

  it('parse failure → null (no guessing)', () => {
    expect(extractLineage('SELECT FROM WHERE nonsense((', 'postgres')).toBeNull();
  });

  it('non-select → null', () => {
    expect(extractLineage('EXPLAIN SELECT 1', 'postgres')).toBeNull();
  });

  it('mssql TOP query parses', () => {
    const l = extractLineage('SELECT TOP 10 ord_sts_cd, COUNT(*) AS n FROM orders GROUP BY ord_sts_cd', 'mssql');
    expect(l?.tables).toEqual(['orders']);
    expect(l?.groupBy).toContain('ord_sts_cd');
  });
});
