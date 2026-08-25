/**
 * Normalize a DuckDB (@duckdb/node-api) cell value to a JSON-safe primitive.
 *
 * The driver returns several types that throw at a JSON / IPC serialization
 * boundary (`JSON.stringify` and `process.send` both reject bigint):
 *   - BIGINT / HUGEINT / UBIGINT      → native `bigint`
 *   - DECIMAL                          → DuckDBDecimalValue { value: bigint, scale, width }
 *   - other DuckDBValue wrappers       → objects exposing `.toString()`
 *
 * DECIMAL is converted to a number via `value / 10^scale` so a currency column
 * reads as `500.0`, not `500n`. Shared by the file-connection child worker and
 * the accelerator's in-process executor so the rule lives in exactly one place.
 */
export function normalizeDuckDbValue(v: unknown): unknown {
  if (v == null) return v;
  if (typeof v === 'bigint') return Number(v);
  if (typeof v === 'object') {
    const o = v as { value?: unknown; scale?: unknown; constructor?: { name?: string }; toString?: () => string };
    // DuckDBDecimalValue: { value: bigint, scale, width }
    if (typeof o.value === 'bigint' && typeof o.scale === 'number') {
      return Number(o.value) / Math.pow(10, o.scale);
    }
    // Other DuckDB value wrappers (dates, timestamps, intervals, …).
    if (typeof o.toString === 'function' && o.constructor?.name?.startsWith('DuckDB')) {
      return o.toString();
    }
  }
  return v;
}
