/**
 * Fail a run before it starts rather than after it has scored zero.
 *
 * An exhausted OpenRouter account returns HTTP 402, which the AI SDK surfaces
 * as `AI_NoOutputGeneratedError` — indistinguishable from a transient empty
 * stream. Every question then "fails", the run completes in fifteen seconds,
 * and the artifact records `EX = 0%` as though it had measured something. Two
 * such runs were produced before anyone looked at why.
 *
 * So the account is probed once up front. A run that cannot pay must announce
 * that, not publish a zero.
 */

/** Live-stream reservations are the largest single charge a question can incur,
 *  so an account below this cannot complete even one question. */
const MIN_USABLE_CREDIT_USD = 1;

export interface ProviderReadiness {
  ok: boolean;
  remainingUsd: number | null;
  detail: string;
}

/**
 * Check the provider can actually serve this run.
 *
 * Only OpenRouter exposes a balance endpoint; other providers return `ok` with
 * a null balance rather than blocking a run we have no way to price-check.
 */
export async function checkProviderReady(provider: string, apiKey: string | undefined): Promise<ProviderReadiness> {
  if (provider !== 'openrouter') {
    return { ok: true, remainingUsd: null, detail: `${provider}: no balance endpoint, not checked` };
  }
  if (!apiKey) return { ok: false, remainingUsd: null, detail: 'OPENROUTER_API_KEY is not set' };

  let res: Response;
  try {
    res = await fetch('https://openrouter.ai/api/v1/credits', {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
  } catch (e) {
    // A network failure here is not evidence the account is broke, and refusing
    // to run on it would block a benchmark for an unrelated blip.
    return { ok: true, remainingUsd: null, detail: `balance check unreachable (${e instanceof Error ? e.message : String(e)})` };
  }
  if (!res.ok) return { ok: true, remainingUsd: null, detail: `balance check returned ${res.status}, not checked` };

  const body = await res.json() as { data?: { total_credits?: number; total_usage?: number } };
  const credits = body.data?.total_credits;
  const usage = body.data?.total_usage;
  if (typeof credits !== 'number' || typeof usage !== 'number') {
    return { ok: true, remainingUsd: null, detail: 'balance check returned an unexpected shape, not checked' };
  }

  const remaining = credits - usage;
  return remaining < MIN_USABLE_CREDIT_USD
    ? {
        ok: false,
        remainingUsd: remaining,
        detail: `OpenRouter balance is $${remaining.toFixed(2)}, below the $${MIN_USABLE_CREDIT_USD} a single question can require. `
          + 'Every question would fail as an empty stream and the run would report EX = 0%. Top up before running.',
      }
    : { ok: true, remainingUsd: remaining, detail: `OpenRouter balance $${remaining.toFixed(2)}` };
}

/** Throw unless the provider can serve the run. */
export async function assertProviderReady(provider: string, apiKey: string | undefined): Promise<ProviderReadiness> {
  const r = await checkProviderReady(provider, apiKey);
  if (!r.ok) throw new Error(r.detail);
  return r;
}
