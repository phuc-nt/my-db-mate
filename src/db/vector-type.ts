/** pgvector column type for Drizzle (384-dim, matches the multilingual embedder). */
import { customType } from 'drizzle-orm/pg-core';

export const vector384 = customType<{ data: number[]; driverData: string }>({
  dataType() {
    return 'vector(384)';
  },
  toDriver(value: number[]): string {
    return `[${value.join(',')}]`;
  },
  fromDriver(value: string): number[] {
    return value.slice(1, -1).split(',').map(Number);
  },
});
