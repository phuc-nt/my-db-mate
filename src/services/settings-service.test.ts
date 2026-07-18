/**
 * LLM settings persistence — focus on the key-keep flow, which is easy to get
 * wrong across providers (a blank key must NEVER silently store the wrong
 * secret: neither the ollama placeholder nor a different provider's key).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '../db/client';
import { appSettings } from '../db/app-settings-schema';
import { saveLlmSettings, getLlmSettings, clearLlmSettings } from './settings-service';

beforeEach(async () => { await clearLlmSettings(); });
afterEach(async () => { await db.delete(appSettings).where(eq(appSettings.key, 'llm')); await clearLlmSettings(); });

describe('saveLlmSettings — key-keep flow', () => {
  it('keeps the stored key when re-saving the SAME keyed provider with a blank key', async () => {
    await saveLlmSettings({ provider: 'openai', model: 'gpt-5.2', apiKey: 'sk-real-key' });
    await saveLlmSettings({ provider: 'openai', model: 'gpt-5.3', apiKey: '' });
    const s = await getLlmSettings();
    expect(s?.apiKey).toBe('sk-real-key');
    expect(s?.model).toBe('gpt-5.3');
  });

  it('rejects a blank key when SWITCHING keyed providers (never keeps the other provider key)', async () => {
    await saveLlmSettings({ provider: 'openai', model: 'gpt-5.2', apiKey: 'sk-openai' });
    await expect(saveLlmSettings({ provider: 'google', model: 'gemini-3-flash', apiKey: '' })).rejects.toThrow('API key required');
  });

  it('rejects a blank key when switching FROM ollama to a keyed provider (placeholder is not a key)', async () => {
    await saveLlmSettings({ provider: 'ollama', model: 'qwen3', baseUrl: 'http://localhost:11434/v1' });
    await expect(saveLlmSettings({ provider: 'openai', model: 'gpt-5.2', apiKey: '' })).rejects.toThrow('API key required');
  });

  it('ollama needs no key and round-trips its base URL', async () => {
    await saveLlmSettings({ provider: 'ollama', model: 'qwen3', baseUrl: 'http://host.local:11434/v1' });
    const s = await getLlmSettings();
    expect(s?.provider).toBe('ollama');
    expect(s?.baseUrl).toBe('http://host.local:11434/v1');
    expect(s?.apiKey).toBe('ollama'); // stored placeholder, ignored by the local server
  });
});
