import { describe, it, expect } from 'vitest';
import { normalizeDuckDbValue } from './duckdb-value';

describe('normalizeDuckDbValue', () => {
  it('converts bigint (BIGINT/HUGEINT) to number', () => {
    expect(normalizeDuckDbValue(42n)).toBe(42);
    expect(normalizeDuckDbValue(0n)).toBe(0);
  });

  it('converts DuckDBDecimalValue via value / 10^scale', () => {
    // DECIMAL(13,1) value 500n scale 1 → 50.0
    expect(normalizeDuckDbValue({ value: 500n, scale: 1, width: 13 })).toBe(50);
    expect(normalizeDuckDbValue({ value: 12345n, scale: 2, width: 10 })).toBe(123.45);
  });

  it('stringifies other DuckDB* wrapper objects', () => {
    class DuckDBTimestampValue { toString() { return '2026-01-01 00:00:00'; } }
    expect(normalizeDuckDbValue(new DuckDBTimestampValue())).toBe('2026-01-01 00:00:00');
  });

  it('passes through JSON-safe primitives and null unchanged', () => {
    expect(normalizeDuckDbValue(5.5)).toBe(5.5);
    expect(normalizeDuckDbValue('hi')).toBe('hi');
    expect(normalizeDuckDbValue(null)).toBe(null);
    expect(normalizeDuckDbValue(true)).toBe(true);
  });

  it('everything it returns is JSON-serializable', () => {
    const inputs = [42n, { value: 500n, scale: 1 }, 'x', 3.14, null];
    for (const v of inputs) expect(() => JSON.stringify(normalizeDuckDbValue(v))).not.toThrow();
  });
});
