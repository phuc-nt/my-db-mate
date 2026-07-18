/**
 * Global app settings — currently the LLM provider configuration.
 *
 * Secrets: the provider API key is AES-256-GCM-encrypted with the same
 * CREDENTIAL_ENC_KEY as connection credentials, and is NEVER returned to the
 * client (GET exposes hasKey + last 4 chars only).
 *
 * Cache: read on every LLM call, so the resolved config is memoized on
 * globalThis (survives HMR, same pattern as ssh-tunnel-manager) and invalidated
 * on save.
 */
import { eq } from 'drizzle-orm';
import { db } from '../db/client';
import { appSettings } from '../db/app-settings-schema';
import { encryptSecret, decryptSecret } from './crypto/credential-cipher';

export type LlmProviderId = 'openrouter' | 'openai' | 'anthropic' | 'google' | 'ollama';

export interface LlmSettings {
  provider: LlmProviderId;
  model: string;
  /** Decrypted key — server-side use only. Ollama stores a placeholder (the
   *  local server ignores it); it is never a real secret there. */
  apiKey: string;
  /** OpenAI-compatible endpoint base URL — Ollama only. Not a secret (it's the
   *  user's own localhost/LAN server), stored in plain JSON. */
  baseUrl?: string;
}

const KEY = 'llm';

interface StoredLlm { provider: LlmProviderId; model: string; apiKeyEncrypted: string; baseUrl?: string }

const g = globalThis as unknown as { __mdmLlmSettingsCache?: LlmSettings | null | undefined };

/** Configured LLM settings, or null when unset (callers fall back to env). */
export async function getLlmSettings(): Promise<LlmSettings | null> {
  if (g.__mdmLlmSettingsCache !== undefined) return g.__mdmLlmSettingsCache;
  const [row] = await db.select().from(appSettings).where(eq(appSettings.key, KEY));
  if (!row) { g.__mdmLlmSettingsCache = null; return null; }
  const stored = JSON.parse(row.value) as StoredLlm;
  const resolved: LlmSettings = {
    provider: stored.provider,
    model: stored.model,
    apiKey: decryptSecret(stored.apiKeyEncrypted),
    ...(stored.baseUrl ? { baseUrl: stored.baseUrl } : {}),
  };
  g.__mdmLlmSettingsCache = resolved;
  return resolved;
}

/** Save LLM settings. Empty apiKey keeps the previously stored key (edit-safe).
 *  Ollama needs no key — the local server ignores it, so a placeholder is stored. */
export async function saveLlmSettings(input: { provider: LlmProviderId; model: string; apiKey?: string; baseUrl?: string }): Promise<void> {
  let apiKeyEncrypted: string;
  if (input.apiKey?.trim()) {
    apiKeyEncrypted = encryptSecret(input.apiKey.trim());
  } else if (input.provider === 'ollama') {
    apiKeyEncrypted = encryptSecret('ollama');
  } else {
    const current = await getLlmSettings();
    // Only reuse a stored key for the SAME keyed provider. The ollama placeholder
    // is never a real key, and a DIFFERENT provider's key won't authenticate —
    // keeping either would 200 at save then 401 on every LLM call.
    if (!current || current.provider === 'ollama' || current.provider !== input.provider) {
      throw new Error('API key required');
    }
    apiKeyEncrypted = encryptSecret(current.apiKey);
  }
  const value = JSON.stringify({
    provider: input.provider, model: input.model, apiKeyEncrypted,
    ...(input.provider === 'ollama' && input.baseUrl?.trim() ? { baseUrl: input.baseUrl.trim() } : {}),
  } satisfies StoredLlm);
  await db.insert(appSettings).values({ key: KEY, value })
    .onConflictDoUpdate({ target: appSettings.key, set: { value, updatedAt: new Date() } });
  g.__mdmLlmSettingsCache = undefined; // re-read on next call
}

/** Clear the configured provider (fall back to env OpenRouter). */
export async function clearLlmSettings(): Promise<void> {
  await db.delete(appSettings).where(eq(appSettings.key, KEY));
  g.__mdmLlmSettingsCache = undefined;
}

/** Safe view for the client: no key material. */
export async function getLlmSettingsPublic() {
  const s = await getLlmSettings();
  if (!s) return { configured: false as const };
  return {
    configured: true as const,
    provider: s.provider,
    model: s.model,
    keyTail: s.apiKey.slice(-4),
    ...(s.baseUrl ? { baseUrl: s.baseUrl } : {}),
  };
}
