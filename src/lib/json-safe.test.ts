import { describe, it, expect } from 'vitest';
import { toJsonSafe } from './json-safe';

describe('toJsonSafe', () => {
  it('converts a bare BigInt to a string', () => {
    expect(toJsonSafe(42n)).toBe('42');
  });

  it('converts BigInt cells inside query result rows without touching other types', () => {
    const rows: unknown[][] = [[1, 'a', 9007199254740993n], [2, null, 0n]];
    const safe = toJsonSafe(rows);
    expect(() => JSON.stringify(safe)).not.toThrow();
    expect(safe).toEqual([[1, 'a', '9007199254740993'], [2, null, '0']]);
  });

  it('converts BigInt values nested in objects', () => {
    const value = { columns: ['n'], rows: [[5n]], rowCount: 5n };
    const safe = toJsonSafe(value);
    expect(() => JSON.stringify(safe)).not.toThrow();
    expect(safe).toEqual({ columns: ['n'], rows: [['5']], rowCount: '5' });
  });

  it('leaves non-BigInt values (including nested arrays/objects) unchanged', () => {
    const value = { a: 1, b: 'x', c: null, d: [1, 2, { e: true }] };
    expect(toJsonSafe(value)).toEqual(value);
  });

  it('leaves a Date object intact (does not collapse it to {})', () => {
    const date = new Date('2024-01-01T00:00:00.000Z');
    const safe = toJsonSafe(date);
    expect(safe).toBe(date);
    expect(JSON.stringify(safe)).toBe('"2024-01-01T00:00:00.000Z"');
  });

  it('leaves Date cells nested in query result rows intact', () => {
    const rows: unknown[][] = [[1, new Date('2024-06-15T12:00:00.000Z'), 5n]];
    const safe = toJsonSafe(rows);
    expect(JSON.stringify(safe)).toBe('[[1,"2024-06-15T12:00:00.000Z","5"]]');
  });

  it('leaves a Buffer intact so it serializes to its native {type,data} shape', () => {
    const buf = Buffer.from([1, 2, 3]);
    const safe = toJsonSafe(buf);
    expect(safe).toBe(buf);
    expect(JSON.parse(JSON.stringify(safe))).toEqual({ type: 'Buffer', data: [1, 2, 3] });
  });
});
