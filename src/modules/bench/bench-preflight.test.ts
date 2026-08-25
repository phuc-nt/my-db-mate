/**
 * The preflight exists to stop a broke account from publishing a zero, so the
 * tests pin both directions: it must block when the balance cannot cover a
 * question, and must NOT block for any reason that is merely unknown — a
 * network blip or an unrecognised response shape has to leave the run alone.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { checkProviderReady } from './bench-preflight';

const KEY = 'sk-test';
function mockFetch(impl: () => Promise<unknown>) {
  vi.stubGlobal('fetch', vi.fn(impl));
}
afterEach(() => vi.unstubAllGlobals());

const jsonRes = (body: unknown, ok = true, status = 200) =>
  Promise.resolve({ ok, status, json: () => Promise.resolve(body) });

describe('checkProviderReady', () => {
  it('blocks the run when the balance cannot cover one question', async () => {
    mockFetch(() => jsonRes({ data: { total_credits: 480, total_usage: 479.92 } }));
    const r = await checkProviderReady('openrouter', KEY);
    expect(r.ok).toBe(false);
    expect(r.remainingUsd).toBeCloseTo(0.08, 2);
    expect(r.detail).toMatch(/EX = 0%/);
  });

  it('allows a run with real credit', async () => {
    mockFetch(() => jsonRes({ data: { total_credits: 480, total_usage: 300 } }));
    const r = await checkProviderReady('openrouter', KEY);
    expect(r.ok).toBe(true);
    expect(r.remainingUsd).toBe(180);
  });

  it('does not block when the balance endpoint is unreachable', async () => {
    mockFetch(() => Promise.reject(new Error('ENOTFOUND')));
    const r = await checkProviderReady('openrouter', KEY);
    expect(r.ok).toBe(true);
    expect(r.remainingUsd).toBeNull();
  });

  it('does not block on an unexpected response shape', async () => {
    mockFetch(() => jsonRes({ data: {} }));
    const r = await checkProviderReady('openrouter', KEY);
    expect(r.ok).toBe(true);
  });

  it('does not block on a non-200 from the balance endpoint', async () => {
    mockFetch(() => jsonRes({}, false, 500));
    const r = await checkProviderReady('openrouter', KEY);
    expect(r.ok).toBe(true);
  });

  it('blocks a missing key rather than starting a run that cannot authenticate', async () => {
    const r = await checkProviderReady('openrouter', undefined);
    expect(r.ok).toBe(false);
  });

  it('leaves providers without a balance endpoint alone', async () => {
    const r = await checkProviderReady('ollama', undefined);
    expect(r.ok).toBe(true);
    expect(r.remainingUsd).toBeNull();
  });
});
