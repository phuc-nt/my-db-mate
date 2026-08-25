/**
 * Cost per question, from a static price table.
 *
 * Prices are per MILLION tokens in USD, copied from the provider's public
 * pricing page on the date recorded below. They are static on purpose: a
 * benchmark result that quotes a cost must be reproducible from the run
 * artifact months later, and a live price lookup would make the same JSONL
 * produce a different dollar figure every time it is read.
 *
 * An unknown model yields `null` cost rather than a guess. A benchmark that
 * invents a price for a model it does not know is worse than one that reports
 * tokens and says nothing about dollars.
 */

export const PRICES_AS_OF = '2026-08-25';

export interface ModelPrice {
  /** USD per million input tokens. */
  inputPerMTok: number;
  /** USD per million output tokens. */
  outputPerMTok: number;
}

/** Keyed by the provider-qualified model id the run actually used. Values are
 *  the OpenRouter list prices read from `GET /api/v1/models` on PRICES_AS_OF,
 *  converted from per-token to per-million-token. */
export const MODEL_PRICES: Record<string, ModelPrice> = {
  'qwen/qwen3.7-max': { inputPerMTok: 1.475, outputPerMTok: 4.425 },
  'deepseek/deepseek-v4-pro': { inputPerMTok: 0.572808, outputPerMTok: 1.145616 },
};

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}

/** Dollars for one question's usage, or null when the model has no listed price. */
export function costUsd(model: string, usage: TokenUsage): number | null {
  const price = MODEL_PRICES[model];
  if (!price) return null;
  return (usage.inputTokens / 1e6) * price.inputPerMTok
    + (usage.outputTokens / 1e6) * price.outputPerMTok;
}
