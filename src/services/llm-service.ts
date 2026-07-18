/**
 * The ONE place that builds a LanguageModel instance. Every feature (agent chat,
 * follow-ups, reports, discovery, mining, enum suggestions) calls getModel().
 *
 * Resolution order:
 *   1. Settings saved in the app (Settings page → app_settings, key encrypted)
 *   2. env fallback, selected by LLM_PROVIDER (default openrouter): the matching
 *      *_API_KEY + *_MODEL. A fresh install with only OPENROUTER_* in .env behaves
 *      exactly as before this service existed.
 */
import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import { createOpenAI } from '@ai-sdk/openai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import type { LanguageModel } from 'ai';
import { getLlmSettings, type LlmProviderId } from './settings-service';

export const OLLAMA_DEFAULT_BASE_URL = 'http://localhost:11434/v1';

function buildModel(provider: LlmProviderId, apiKey: string, model: string, baseUrl?: string): LanguageModel {
  switch (provider) {
    case 'openrouter': return createOpenRouter({ apiKey })(model);
    case 'openai': return createOpenAI({ apiKey })(model);
    case 'anthropic': return createAnthropic({ apiKey })(model);
    case 'google': return createGoogleGenerativeAI({ apiKey })(model);
    // Ollama speaks the OpenAI-compatible API on /v1; the key is ignored by the
    // local server but the SDK requires a non-empty string.
    case 'ollama': return createOpenAI({ apiKey: apiKey || 'ollama', baseURL: baseUrl || OLLAMA_DEFAULT_BASE_URL })(model);
  }
}

/** Per-provider env fallback (key + model + a sensible default model name).
 *  keyRequired=false: Ollama runs without any key. */
const ENV_FALLBACK: Record<LlmProviderId, { keyVar: string; modelVar: string; defaultModel: string; keyRequired: boolean; baseUrlVar?: string }> = {
  openrouter: { keyVar: 'OPENROUTER_API_KEY', modelVar: 'OPENROUTER_MODEL', defaultModel: 'qwen/qwen3.7-max', keyRequired: true },
  openai: { keyVar: 'OPENAI_API_KEY', modelVar: 'OPENAI_MODEL', defaultModel: 'gpt-5.2', keyRequired: true },
  anthropic: { keyVar: 'ANTHROPIC_API_KEY', modelVar: 'ANTHROPIC_MODEL', defaultModel: 'claude-sonnet-5', keyRequired: true },
  google: { keyVar: 'GOOGLE_GENERATIVE_AI_API_KEY', modelVar: 'GOOGLE_MODEL', defaultModel: 'gemini-3-flash', keyRequired: true },
  ollama: { keyVar: 'OLLAMA_API_KEY', modelVar: 'OLLAMA_MODEL', defaultModel: 'qwen3', keyRequired: false, baseUrlVar: 'OLLAMA_BASE_URL' },
};

function isProvider(v: string | undefined): v is LlmProviderId {
  return v === 'openrouter' || v === 'openai' || v === 'anthropic' || v === 'google' || v === 'ollama';
}

export async function getModel(): Promise<LanguageModel> {
  const settings = await getLlmSettings();
  if (settings) return buildModel(settings.provider, settings.apiKey, settings.model, settings.baseUrl);

  // env fallback — LLM_PROVIDER selects which provider's *_API_KEY / *_MODEL to use.
  const provider: LlmProviderId = isProvider(process.env.LLM_PROVIDER) ? process.env.LLM_PROVIDER : 'openrouter';
  const cfg = ENV_FALLBACK[provider];
  const apiKey = process.env[cfg.keyVar];
  if (!apiKey && cfg.keyRequired) throw new Error(`No LLM configured — set one in Settings or provide ${cfg.keyVar}`);
  const baseUrl = cfg.baseUrlVar ? process.env[cfg.baseUrlVar] : undefined;
  return buildModel(provider, apiKey ?? '', process.env[cfg.modelVar] ?? cfg.defaultModel, baseUrl);
}

/** Build a model from an UNSAVED config — used by the Settings "Test" button. */
export function getModelForTest(provider: LlmProviderId, apiKey: string, model: string, baseUrl?: string): LanguageModel {
  return buildModel(provider, apiKey, model, baseUrl);
}
