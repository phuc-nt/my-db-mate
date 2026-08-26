/**
 * Which failures are retried.
 *
 * The predicate decides whether a question gets another attempt, so it sits
 * between two opposite errors: too narrow and a provider blip scores as a
 * wrong answer (a real run lost 4 of 20 questions that way), too broad and a
 * genuine agent bug is retried until it passes, inflating the score and hiding
 * the bug. Everything that is not unambiguously the transport is left alone.
 */
import { describe, it, expect } from 'vitest';
import { isTransientProviderError } from './bench-runner';

describe('isTransientProviderError', () => {
  it('retries the failure that actually broke a run', () => {
    expect(isTransientProviderError(new Error('No output generated. Check the stream for errors.'))).toBe(true);
  });

  it.each([
    ['rate limit exceeded', 'rate limit'],
    ['429 Too Many Requests', 'http 429'],
    ['upstream returned 503', 'http 5xx'],
    ['read ECONNRESET', 'dropped socket'],
    ['fetch failed', 'transport'],
    ['socket hang up', 'dropped socket'],
  ])('retries %s (%s)', (msg) => {
    expect(isTransientProviderError(new Error(msg))).toBe(true);
  });

  it.each([
    ['no such table: customers', 'a schema mistake is the model being wrong'],
    ['answer contained no fenced SQL block', 'a formatting failure is the model being wrong'],
    ['Multiple statements are not allowed', 'a gate refusal must not be retried into passing'],
    ['Cannot read properties of undefined', 'a crash in our own code must stay visible'],
    ['400 Bad Request', 'a 4xx other than 429 is our malformed request'],
  ])('does NOT retry %s — %s', (msg) => {
    expect(isTransientProviderError(new Error(msg))).toBe(false);
  });

  it('does not treat a digit run inside a larger number as a 5xx', () => {
    expect(isTransientProviderError(new Error('row 1503 failed a constraint'))).toBe(false);
  });
});
