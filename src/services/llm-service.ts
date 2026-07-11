/**
 * The ONE place that builds a LanguageModel instance. Every feature (agent chat,
 * follow-ups, reports, discovery, mining, enum suggestions) calls getModel().
 *
 * Resolution order:
 *   1. Settings saved in the app (Settings page → app_settings, key encrypted)
 *   2. env fallback: OPENROUTER_API_KEY + OPENROUTER_MODEL — a fresh install with
 *      only .env configured behaves exactly as before this service existed.
 */
import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import { createOpenAI } from '@ai-sdk/openai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import type { LanguageModel } from 'ai';
import { getLlmSettings, type LlmProviderId } from './settings-service';

const ENV_DEFAULT_MODEL = 'qwen/qwen3.7-max';

function buildModel(provider: LlmProviderId, apiKey: string, model: string): LanguageModel {
  switch (provider) {
    case 'openrouter': return createOpenRouter({ apiKey })(model);
    case 'openai': return createOpenAI({ apiKey })(model);
    case 'anthropic': return createAnthropic({ apiKey })(model);
    case 'google': return createGoogleGenerativeAI({ apiKey })(model);
  }
}

export async function getModel(): Promise<LanguageModel> {
  const settings = await getLlmSettings();
  if (settings) return buildModel(settings.provider, settings.apiKey, settings.model);
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error('No LLM configured — set one in Settings or provide OPENROUTER_API_KEY');
  return buildModel('openrouter', apiKey, process.env.OPENROUTER_MODEL ?? ENV_DEFAULT_MODEL);
}

/** Build a model from an UNSAVED config — used by the Settings "Test" button. */
export function getModelForTest(provider: LlmProviderId, apiKey: string, model: string): LanguageModel {
  return buildModel(provider, apiKey, model);
}
