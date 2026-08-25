/**
 * The health report is the thing a stuck user reads, and it travels to an
 * unauthenticated endpoint. Two properties matter enough to pin down: it must
 * distinguish the ways an LLM config can be unusable (missing vs the
 * .env.example placeholder need different advice), and it must never carry key
 * material to a surface anyone can curl.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isPlaceholderKey } from './llm-service';

/** Settings are consulted before env; an empty settings row is what forces the
 *  env-fallback path these cases are about. */
vi.mock('./settings-service', () => ({ getLlmSettings: vi.fn(async () => null), readLlmSettings: vi.fn(async () => null) }));
/** The real one loads a local model — irrelevant here and slow. */
vi.mock('./embedding-service', () => ({ embed: vi.fn(async () => [0.1]) }));

/** The live probe spends a real completion; the cases below only care about how
 *  a provider's rejection wording is classified, so the call itself is faked. */
const generateTextMock = vi.hoisted(() => vi.fn());
vi.mock('ai', () => ({ generateText: generateTextMock }));

const ENV_KEYS = ['LLM_PROVIDER', 'OPENROUTER_API_KEY', 'OPENROUTER_MODEL', 'ANTHROPIC_API_KEY', 'OLLAMA_MODEL'] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  // The live probe caches across calls (see LIVE_PROBE_TTL_MS). Each case here
  // asserts about a fresh probe, so the cache starts empty.
  delete (globalThis as { __mdmLiveProbe?: unknown }).__mdmLiveProbe;
  generateTextMock.mockReset();
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  vi.resetModules();
});

async function llmCheck() {
  const { getSetupHealth } = await import('./setup-health-service');
  const health = await getSetupHealth({ embeddingTimeoutMs: 1000 });
  return { health, llm: health.checks.llm };
}

describe('isPlaceholderKey', () => {
  it('treats the .env.example literals as unset', () => {
    for (const p of ['sk-or-...', 'sk-...', 'sk-ant-...']) expect(isPlaceholderKey(p)).toBe(true);
  });

  it('accepts a real-looking key and rejects blanks', () => {
    expect(isPlaceholderKey('sk-or-v1-abc123')).toBe(false);
    expect(isPlaceholderKey('')).toBe(true);
    expect(isPlaceholderKey('   ')).toBe(true);
    expect(isPlaceholderKey(undefined)).toBe(true);
  });
});

describe('LLM check', () => {
  it('reports `missing` when no key is set', async () => {
    delete process.env.OPENROUTER_API_KEY;
    process.env.LLM_PROVIDER = 'openrouter';
    const { llm } = await llmCheck();
    expect(llm.status).toBe('missing');
    expect(llm.detail).toContain('OPENROUTER_API_KEY');
  });

  // The whole reason this phase exists: a fresh `cp .env.example .env` looks
  // configured and dies at the provider on the first question. `missing` and
  // `placeholder` must stay distinguishable — they need different advice.
  it('reports `placeholder` for the untouched .env.example value', async () => {
    process.env.LLM_PROVIDER = 'openrouter';
    process.env.OPENROUTER_API_KEY = 'sk-or-...';
    const { llm } = await llmCheck();
    expect(llm.status).toBe('placeholder');
  });

  it('reports `configured` for a real key, naming provider and model', async () => {
    process.env.LLM_PROVIDER = 'openrouter';
    process.env.OPENROUTER_API_KEY = 'sk-or-v1-realkey';
    process.env.OPENROUTER_MODEL = 'some/model';
    const { llm } = await llmCheck();
    expect(llm.status).toBe('configured');
    expect(llm.provider).toBe('openrouter');
    expect(llm.model).toBe('some/model');
  });

  // Ollama runs locally with no key, so requiring one would report a healthy
  // local-only install as broken.
  it('counts a keyless Ollama install as configured', async () => {
    process.env.LLM_PROVIDER = 'ollama';
    delete process.env.OPENROUTER_API_KEY;
    const { llm } = await llmCheck();
    expect(llm.status).toBe('configured');
    expect(llm.provider).toBe('ollama');
  });

  it('skips the live probe unless asked, so a plain check costs nothing', async () => {
    process.env.OPENROUTER_API_KEY = 'sk-or-v1-realkey';
    const { health } = await llmCheck();
    expect(health.checks.llmLive.status).toBe('skipped');
  });
});

describe('health report as a payload', () => {
  // The endpoint has no auth in front of it (single-user by design), so a key
  // leaking into any `detail` string would be readable by anyone who can reach
  // the port.
  it('never serializes key material', async () => {
    process.env.LLM_PROVIDER = 'openrouter';
    process.env.OPENROUTER_API_KEY = 'sk-or-v1-SUPERSECRETVALUE';
    const { health } = await llmCheck();
    expect(JSON.stringify(health)).not.toContain('SUPERSECRETVALUE');
  });

  it('degrades the overall status when any check is unhealthy', async () => {
    delete process.env.OPENROUTER_API_KEY;
    process.env.LLM_PROVIDER = 'openrouter';
    const { health } = await llmCheck();
    expect(health.status).toBe('degraded');
  });
});

/**
 * A rejected key is the single most common live-probe failure, and `auth_failed`
 * is what tells the user to go fix the key rather than to go debug their network.
 * Providers word that rejection very differently — OpenRouter's is a bare "User
 * not found." with no status code — so the classification is pinned here.
 */
describe('live probe classification', () => {
  async function liveProbe(err: Error) {
    process.env.LLM_PROVIDER = 'openrouter';
    process.env.OPENROUTER_API_KEY = 'sk-or-v1-realkey';
    generateTextMock.mockRejectedValueOnce(err);
    const { getSetupHealth } = await import('./setup-health-service');
    const health = await getSetupHealth({ live: true, embeddingTimeoutMs: 1000 });
    return health.checks.llmLive;
  }

  it.each([
    ['User not found.', 'openrouter rejecting an unknown key'],
    ['No auth credentials found', 'a request with no key at all'],
    ['401 Unauthorized', 'a plain status-code rejection'],
    ['Incorrect API key provided', 'openai-style wording'],
  ])('classifies %j as auth_failed (%s)', async (msg) => {
    expect((await liveProbe(new Error(msg))).status).toBe('auth_failed');
  });

  // Not everything that fails is a bad key — a provider outage must stay
  // distinguishable, or the advice sends the user to rotate a working key.
  it('leaves non-auth failures as a generic error', async () => {
    expect((await liveProbe(new Error('fetch failed: ECONNREFUSED'))).status).toBe('error');
  });

  /**
   * A provider that echoes the submitted key in its rejection body would put
   * that key into an unauthenticated payload. The settings test-LLM route
   * already redacts the same probe for exactly this reason; this pins that the
   * health service does too, on the live path the other leak test never reaches.
   */
  it('redacts the key out of a provider error that echoes it', async () => {
    const KEY = 'sk-or-v1-SUPERSECRETVALUE';
    process.env.LLM_PROVIDER = 'openrouter';
    process.env.OPENROUTER_API_KEY = KEY;
    generateTextMock.mockRejectedValueOnce(new Error(`Incorrect API key provided: ${KEY}. Check your key.`));
    const { getSetupHealth } = await import('./setup-health-service');
    const health = await getSetupHealth({ live: true, embeddingTimeoutMs: 1000 });
    expect(health.checks.llmLive.status).toBe('auth_failed');
    expect(health.checks.llmLive.detail).toContain('***');
    expect(JSON.stringify(health)).not.toContain('SUPERSECRETVALUE');
  });

  // A hostile or merely verbose provider body must not become the payload.
  it('caps the detail length', async () => {
    process.env.LLM_PROVIDER = 'openrouter';
    process.env.OPENROUTER_API_KEY = 'sk-or-v1-realkey';
    generateTextMock.mockRejectedValueOnce(new Error('x'.repeat(5000)));
    const { getSetupHealth } = await import('./setup-health-service');
    const health = await getSetupHealth({ live: true, embeddingTimeoutMs: 1000 });
    expect(health.checks.llmLive.detail!.length).toBeLessThanOrEqual(300);
  });

  /**
   * `/api/health` has no auth in front of it and this is the only check that
   * spends money, so an unbounded loop over `?live=1` would bill the user's
   * provider account. One real call per minute is the ceiling; a hand-run
   * `setup.sh --check` is never inside that window.
   */
  it('spends only one completion per minute however often it is asked', async () => {
    process.env.LLM_PROVIDER = 'openrouter';
    process.env.OPENROUTER_API_KEY = 'sk-or-v1-realkey';
    generateTextMock.mockResolvedValue({ text: 'ok' });
    const { getSetupHealth } = await import('./setup-health-service');
    for (let i = 0; i < 5; i++) await getSetupHealth({ live: true, embeddingTimeoutMs: 1000 });
    expect(generateTextMock).toHaveBeenCalledTimes(1);
  });

  // A rejected key retried in a loop still costs the provider a rejection per
  // call, and rate limits count failures.
  it('caches failures too', async () => {
    process.env.LLM_PROVIDER = 'openrouter';
    process.env.OPENROUTER_API_KEY = 'sk-or-v1-realkey';
    generateTextMock.mockRejectedValue(new Error('User not found.'));
    const { getSetupHealth } = await import('./setup-health-service');
    const first = await getSetupHealth({ live: true, embeddingTimeoutMs: 1000 });
    const second = await getSetupHealth({ live: true, embeddingTimeoutMs: 1000 });
    expect(generateTextMock).toHaveBeenCalledTimes(1);
    expect(second.checks.llmLive.status).toBe('auth_failed');
    // A reused answer says so — otherwise a stale `reachable` reads as proof
    // that a key the user just changed works.
    expect(second.checks.llmLive.detail).toMatch(/cached \d+s ago/);
    expect(first.checks.llmLive.detail).not.toMatch(/cached/);
  });

  it('reports reachable when the probe succeeds', async () => {
    process.env.LLM_PROVIDER = 'openrouter';
    process.env.OPENROUTER_API_KEY = 'sk-or-v1-realkey';
    generateTextMock.mockResolvedValueOnce({ text: 'ok' });
    const { getSetupHealth } = await import('./setup-health-service');
    const health = await getSetupHealth({ live: true, embeddingTimeoutMs: 1000 });
    expect(health.checks.llmLive.status).toBe('reachable');
  });
});
