/**
 * Which model did the run ACTUALLY use?
 *
 * `--model qwen/qwen3.7-max` sets `OPENROUTER_MODEL`, but `getModel()` resolves
 * saved app settings FIRST and only falls back to env. So on a machine where the
 * user has configured a model in Settings, the env variable is ignored and every
 * question would silently run on the wrong model — producing a result file that
 * says one thing and measured another.
 *
 * This resolves the model id the same way `getModel()` does and lets the runner
 * refuse to start on a mismatch. A benchmark that mislabels its model is not a
 * weaker benchmark; it is a false one.
 */
import { getLlmSettings } from '@/core/app-state/settings-service';
import { ENV_FALLBACK, isProvider } from '@/core/model/llm-service';
import type { LlmProviderId } from '@/core/app-state/settings-service';

export interface ResolvedModel {
  provider: LlmProviderId;
  model: string;
  /** 'settings' when saved app settings won, 'env' when the fallback did. */
  source: 'settings' | 'env';
}

export async function resolveActiveModel(): Promise<ResolvedModel> {
  const settings = await getLlmSettings();
  if (settings) return { provider: settings.provider, model: settings.model, source: 'settings' };

  const provider: LlmProviderId = isProvider(process.env.LLM_PROVIDER) ? process.env.LLM_PROVIDER : 'openrouter';
  const cfg = ENV_FALLBACK[provider];
  return { provider, model: process.env[cfg.modelVar] ?? cfg.defaultModel, source: 'env' };
}

/**
 * Throw unless the model that will actually run is the one that was requested.
 *
 * The error names the source so the fix is obvious: settings winning over env is
 * the failure mode a user hits, and "clear the model in Settings" is the action.
 */
export async function assertModel(requested: string): Promise<ResolvedModel> {
  const active = await resolveActiveModel();
  if (active.model !== requested) {
    throw new Error(
      `requested model "${requested}" but ${active.source} resolves to "${active.model}"` +
      (active.source === 'settings'
        ? ' — saved app settings take precedence over the env fallback; clear the model in Settings to benchmark a different one.'
        : ` — set ${ENV_FALLBACK[active.provider].modelVar}.`),
    );
  }
  return active;
}
