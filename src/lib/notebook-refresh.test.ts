import { describe, expect, it } from 'vitest';
import { extractRefreshPairs } from './notebook-refresh';

const turn = (n: number, sql: string) => `## Q${n}: question\n\n\`\`\`sql\n${sql}\n\`\`\`\n\n{{table:t${n}_1}}\n\nnarrative\n`;

describe('extractRefreshPairs', () => {
  it('pairs placeholder with its preceding fence', () => {
    const md = turn(1, 'SELECT 1') + turn(2, 'SELECT 2');
    expect(extractRefreshPairs(md)).toEqual([
      { turnId: 't1_1', sql: 'SELECT 1' },
      { turnId: 't2_1', sql: 'SELECT 2' },
    ]);
  });

  it('12 turns map correctly (no jsonb key-order trap)', () => {
    const md = Array.from({ length: 12 }, (_, i) => turn(i + 1, `SELECT ${i + 1}`)).join('\n');
    const pairs = extractRefreshPairs(md);
    expect(pairs).toHaveLength(12);
    expect(pairs[9]).toEqual({ turnId: 't10_1', sql: 'SELECT 10' });
  });

  it('sensitive fence (no placeholder) is skipped and does not shift mapping', () => {
    const md = turn(1, 'SELECT 1')
      + '\n```sql\nSELECT secret FROM users\n```\n_Result omitted — this query reads a column marked sensitive._\n'
      + turn(3, 'SELECT 3');
    const pairs = extractRefreshPairs(md);
    // t3_1 must map to SELECT 3, NOT the sensitive fence between.
    expect(pairs).toEqual([
      { turnId: 't1_1', sql: 'SELECT 1' },
      { turnId: 't3_1', sql: 'SELECT 3' },
    ]);
  });

  it('placeholder with no fence anywhere before it → skipped', () => {
    expect(extractRefreshPairs('{{table:t1_1}}\n')).toEqual([]);
  });

  it('multiple SQL in one turn pair in order', () => {
    const md = '## Q1: q\n\n```sql\nSELECT a\n```\n\n{{table:t1_1}}\n\n```sql\nSELECT b\n```\n\n{{table:t1_2}}\n';
    expect(extractRefreshPairs(md)).toEqual([
      { turnId: 't1_1', sql: 'SELECT a' },
      { turnId: 't1_2', sql: 'SELECT b' },
    ]);
  });

  it('empty markdown → empty', () => {
    expect(extractRefreshPairs('')).toEqual([]);
  });
});
