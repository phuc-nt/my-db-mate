import { describe, expect, it } from 'vitest';
import { defaultDateRange, hasDateRangePlaceholders, isValidIsoDate, substituteDateRange } from './sql-param';

describe('hasDateRangePlaceholders', () => {
  it('detects {{from}}/{{to}} with flexible spacing and case', () => {
    expect(hasDateRangePlaceholders('WHERE d BETWEEN {{from}} AND {{ TO }}')).toBe(true);
    expect(hasDateRangePlaceholders('SELECT 1')).toBe(false);
    expect(hasDateRangePlaceholders('SELECT {{other}}')).toBe(false);
  });
});

describe('substituteDateRange', () => {
  it('replaces with quoted ISO literals', () => {
    expect(substituteDateRange('BETWEEN {{from}} AND {{to}}', { from: '2026-01-01', to: '2026-06-30' }))
      .toBe("BETWEEN '2026-01-01' AND '2026-06-30'");
  });

  it('leaves SQL without placeholders untouched', () => {
    expect(substituteDateRange('SELECT 1', { from: '2026-01-01', to: '2026-01-02' })).toBe('SELECT 1');
  });

  it('rejects injection attempts in from', () => {
    expect(() => substituteDateRange('x {{from}}', { from: "2026-01-01' OR '1'='1", to: '2026-01-02' }))
      .toThrow(/invalid from date/);
  });

  it('rejects non-ISO and impossible dates', () => {
    expect(() => substituteDateRange('{{to}}', { from: '2026-01-01', to: '01/02/2026' })).toThrow();
    expect(() => substituteDateRange('{{to}}', { from: '2026-01-01', to: '2026-02-31' })).toThrow();
  });

  it('replaces repeated placeholders everywhere', () => {
    const out = substituteDateRange('{{from}} {{from}} {{to}}', { from: '2026-03-01', to: '2026-03-31' });
    expect(out).toBe("'2026-03-01' '2026-03-01' '2026-03-31'");
  });
});

describe('isValidIsoDate', () => {
  it('accepts real dates, rejects garbage', () => {
    expect(isValidIsoDate('2026-02-28')).toBe(true);
    expect(isValidIsoDate('2026-02-31')).toBe(false);
    expect(isValidIsoDate('26-1-1')).toBe(false);
  });
});

describe('defaultDateRange', () => {
  it('is 30 days ending at the given now', () => {
    const r = defaultDateRange(new Date('2026-07-12T10:00:00Z'));
    expect(r).toEqual({ from: '2026-06-12', to: '2026-07-12' });
  });
});
