/** Recursively converts BigInt values to strings so a value is safe to pass to
 *  JSON.stringify (which throws on BigInt) — e.g. query result rows, where
 *  BigQuery/large COUNT/SUM aggregates can surface BigInt cells.
 *
 *  Date and Buffer/typed-array cells are passed through unchanged rather than
 *  walked as plain objects — Object.entries() on a Date returns [] (would
 *  serialize to "{}", destroying the timestamp) and walking a Buffer's indices
 *  would change its JSON.stringify shape from {"type":"Buffer","data":[...]}
 *  to {"0":..,"1":..}. Left as-is, JSON.stringify handles both natively. */
export function toJsonSafe<T>(value: T): T {
  if (typeof value === 'bigint') return value.toString() as unknown as T;
  if (value instanceof Date || value instanceof Uint8Array) return value;
  if (Array.isArray(value)) return value.map(toJsonSafe) as unknown as T;
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = toJsonSafe(v);
    }
    return out as T;
  }
  return value;
}
