/**
 * CI gate for the SQL safety validator: zero adversarial leaks is mandatory,
 * and every legitimate SELECT must pass (zero false positives). If a case here
 * fails, the "29/29 attacks blocked" claim in docs/features.md is no longer true.
 */
import { describe, it, expect } from 'vitest';
import { validateSql } from './safety-service';
import { MUST_BLOCK, MUST_PASS } from './adversarial-cases';

describe('adversarial statements are blocked', () => {
  it.each(MUST_BLOCK.map((c) => [`${c.dialect}: ${c.label}`, c] as const))(
    '%s',
    (_name, c) => {
      const v = validateSql(c.sql, c.dialect);
      expect(v.status).toBe('blocked');
    },
  );
});

describe('legitimate SELECTs pass (false-positive check)', () => {
  it.each(MUST_PASS.map((c) => [`${c.dialect}: ${c.label}`, c] as const))(
    '%s',
    (_name, c) => {
      const v = validateSql(c.sql, c.dialect);
      expect(v.status).toBe('ok');
    },
  );
});
