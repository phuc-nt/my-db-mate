import { describe, expect, it } from 'vitest';
import { shouldAutoChart } from './chart-spec-service';

const rows = (n: number, make: (i: number) => unknown[]) => Array.from({ length: n }, (_, i) => make(i));

describe('shouldAutoChart', () => {
  it('time series → line, regardless of row count', () => {
    const spec = shouldAutoChart(['month', 'revenue'], rows(48, (i) => [`2022-${(i % 12) + 1}`, i * 100]));
    expect(spec?.type).toBe('line');
  });

  it('small categorical 2-col → bar', () => {
    const spec = shouldAutoChart(['seg_cd', 'count'], rows(4, (i) => [`S${i}`, i * 10]));
    expect(spec?.type).toBe('bar');
  });

  it('categorical with >20 rows → table (null)', () => {
    expect(shouldAutoChart(['name', 'count'], rows(30, (i) => [`p${i}`, i]))).toBeNull();
  });

  it('3+ columns categorical → table (null)', () => {
    expect(shouldAutoChart(['a', 'b', 'c'], rows(5, (i) => [`x${i}`, i, i * 2]))).toBeNull();
  });

  it('single column → null', () => {
    expect(shouldAutoChart(['count'], rows(1, () => [42]))).toBeNull();
  });

  it('no numeric column → null', () => {
    expect(shouldAutoChart(['a', 'b'], rows(3, (i) => [`x${i}`, `y${i}`]))).toBeNull();
  });

  it('empty rows → null', () => {
    expect(shouldAutoChart(['month', 'revenue'], [])).toBeNull();
  });

  it('created_at label counts as temporal', () => {
    const spec = shouldAutoChart(['created_at', 'total'], rows(25, (i) => [`2026-01-${i + 1}`, i]));
    expect(spec?.type).toBe('line');
  });
});
