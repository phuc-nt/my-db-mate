import { describe, expect, it } from 'vitest';
import { renderDateContext } from './date-context';

describe('renderDateContext', () => {
  it('mid-year, mid-quarter (2026-07-12 is a Sunday)', () => {
    const s = renderDateContext(new Date(2026, 6, 12));
    expect(s).toContain('Today is 2026-07-12 (Sunday)');
    expect(s).toContain('this month: 2026-07-01 .. 2026-07-31');
    expect(s).toContain('last month: 2026-06-01 .. 2026-06-30');
    expect(s).toContain('this quarter (Q3 2026): 2026-07-01 .. 2026-09-30');
    expect(s).toContain('last quarter (Q2 2026): 2026-04-01 .. 2026-06-30');
    expect(s).toContain('year to date: 2026-01-01 .. 2026-07-12');
  });

  it('January — last month and last quarter cross the year boundary', () => {
    const s = renderDateContext(new Date(2026, 0, 5));
    expect(s).toContain('last month: 2025-12-01 .. 2025-12-31');
    expect(s).toContain('this quarter (Q1 2026): 2026-01-01 .. 2026-03-31');
    expect(s).toContain('last quarter (Q4 2025): 2025-10-01 .. 2025-12-31');
    expect(s).toContain('last year: 2025-01-01 .. 2025-12-31');
  });

  it('first day of a quarter', () => {
    const s = renderDateContext(new Date(2026, 3, 1));
    expect(s).toContain('this quarter (Q2 2026): 2026-04-01 .. 2026-06-30');
    expect(s).toContain('last quarter (Q1 2026): 2026-01-01 .. 2026-03-31');
    expect(s).toContain('QTD ends 2026-04-01');
  });

  it('December — this month ends on the 31st, Q4 correct', () => {
    const s = renderDateContext(new Date(2025, 11, 31));
    expect(s).toContain('this month: 2025-12-01 .. 2025-12-31');
    expect(s).toContain('this quarter (Q4 2025): 2025-10-01 .. 2025-12-31');
  });

  it('February in a leap year', () => {
    const s = renderDateContext(new Date(2028, 1, 10));
    expect(s).toContain('this month: 2028-02-01 .. 2028-02-29');
  });

  it('March — last month is February (short month edge)', () => {
    const s = renderDateContext(new Date(2026, 2, 15));
    expect(s).toContain('last month: 2026-02-01 .. 2026-02-28');
  });
});
