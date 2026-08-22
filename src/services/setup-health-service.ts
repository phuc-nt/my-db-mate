/**
 * Is this install actually healthy?
 *
 * The install path used to fail late and silently: a blank or placeholder LLM key
 * produced a working-looking app whose FIRST question died at the provider. This
 * service is the one place that answers "is everything wired up", so the same
 * verdict reaches the terminal (`setup.sh --check`), the HTTP surface
 * (`/api/health`), and the onboarding UI. Duplicating these checks per surface is
 * how they drift.
 *
 * Every check is independently caught: one broken dependency must not mask the
 * state of the others, since the whole point is telling a stuck user which piece
 * is wrong.
 *
 * Nothing here returns a secret. The report travels to an unauthenticated
 * endpoint (the app has no auth layer by design), so it carries booleans, status
 * words, provider and model names — never key material or connection strings.
 */
import fs from 'node:fs';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import { generateText } from 'ai';
import { db } from '../db/client';
import { readLlmSettings } from './settings-service';
import { ENV_FALLBACK, isProvider, isPlaceholderKey, getModel } from './llm-service';
import { embed } from './embedding-service';

export type CheckStatus =
  | 'ok'
  | 'unreachable'
  | 'pending'
  | 'configured'
  | 'missing'
  | 'placeholder'
  | 'reachable'
  | 'auth_failed'
  | 'error'
  | 'loading'
  | 'readonly'
  | 'skipped';

export interface Check {
  status: CheckStatus;
  detail?: string;
}

export interface SetupHealth {
  status: 'ok' | 'degraded';
  checks: {
    appDb: Check;
    migrations: Check;
    llm: Check & { provider?: string; model?: string; source?: 'settings' | 'env' };
    llmLive: Check;
    embeddings: Check;
    demoDir: Check;
  };
}

/** Statuses that mean "this piece is fine". Everything else degrades the install.
 *  `skipped` counts as fine: the live LLM probe is opt-in, and not asking for it
 *  is not a fault. */
const HEALTHY: ReadonlySet<CheckStatus> = new Set(['ok', 'configured', 'reachable', 'skipped']);

/** Cap on any `detail` string. Matches the settings test-LLM route's cap — the
 *  detail is a hint for a human, and an unbounded provider or driver body on an
 *  unauthenticated endpoint is a payload, not a hint. */
const DETAIL_MAX = 300;

/**
 * Every `detail` in this report goes to an unauthenticated endpoint, so no error
 * string reaches it raw. Provider errors can echo the submitted key verbatim
 * (the settings test-LLM route redacts the same live probe for this reason), and
 * database drivers can echo connection strings. `secrets` holds whatever this
 * call knows to be sensitive; anything that survives is truncated regardless.
 */
function messageOf(e: unknown, secrets: readonly (string | undefined)[] = []): string {
  let msg = e instanceof Error ? e.message : String(e);
  for (const secret of secrets) {
    const s = secret?.trim();
    if (s) msg = msg.split(s).join('***');
  }
  return msg.slice(0, DETAIL_MAX);
}

async function checkAppDb(): Promise<Check> {
  try {
    await db.execute(sql`select 1`);
    return { status: 'ok' };
  } catch (e) {
    return { status: 'unreachable', detail: messageOf(e) };
  }
}

/**
 * Migrations are compared by count, not by name: drizzle records every applied
 * migration in its own table, so a container started against an older image (or a
 * dev who forgot `db:migrate`) shows fewer applied than the repo ships. Reporting
 * the two numbers is what makes "restart the container" an obvious fix.
 */
async function checkMigrations(): Promise<Check> {
  try {
    const applied = await db.execute<{ count: string }>(
      sql`select count(*)::text as count from drizzle.__drizzle_migrations`,
    );
    const appliedCount = Number(applied.rows[0]?.count ?? 0);
    const onDisk = fs.readdirSync(path.resolve(process.cwd(), 'drizzle')).filter((f) => f.endsWith('.sql')).length;
    if (appliedCount < onDisk) {
      return { status: 'pending', detail: `${appliedCount}/${onDisk} applied` };
    }
    return { status: 'ok', detail: `${appliedCount} applied` };
  } catch (e) {
    // Postgres 42P01 = undefined_table: the migrations table itself is missing,
    // which is exactly what a database that never ran one looks like. Any OTHER
    // failure (permissions, a dropped connection) is not a pending migration,
    // and reporting it as one sends the user to the wrong fix.
    const code = (e as { code?: string })?.code;
    if (code === '42P01') return { status: 'pending', detail: 'no migrations have been applied' };
    return { status: 'error', detail: messageOf(e) };
  }
}

/**
 * Resolve the LLM config the way `getModel()` does — saved settings first, then
 * the env fallback — but report instead of throwing, and distinguish "no key" from
 * "the placeholder from .env.example". They need different advice, and collapsing
 * them into one error is what made the placeholder case so confusing.
 */
async function checkLlm(): Promise<SetupHealth['checks']['llm']> {
  try {
    // Read past the cache: a key rotated outside this process would otherwise be
    // reported from a stale entry (see readLlmSettings).
    const settings = await readLlmSettings();
    if (settings) {
      const base = { provider: settings.provider, model: settings.model, source: 'settings' as const };
      // A placeholder pasted into the Settings page is the same late-and-silent
      // 401 this whole check exists to prevent — it just arrives by a different
      // door than .env, so the guard has to sit on both.
      if (ENV_FALLBACK[settings.provider].keyRequired && isPlaceholderKey(settings.apiKey)) {
        return { ...base, status: 'placeholder', detail: 'the saved key is a placeholder, not a real key' };
      }
      return { ...base, status: 'configured' };
    }
    const provider = isProvider(process.env.LLM_PROVIDER) ? process.env.LLM_PROVIDER : 'openrouter';
    const cfg = ENV_FALLBACK[provider];
    const model = process.env[cfg.modelVar] ?? cfg.defaultModel;
    if (!cfg.keyRequired) return { status: 'configured', provider, model, source: 'env' };

    const key = process.env[cfg.keyVar];
    if (!key?.trim()) {
      return { status: 'missing', provider, model, source: 'env', detail: `${cfg.keyVar} is not set` };
    }
    if (isPlaceholderKey(key)) {
      return { status: 'placeholder', provider, model, source: 'env', detail: `${cfg.keyVar} still holds the .env.example placeholder` };
    }
    return { status: 'configured', provider, model, source: 'env' };
  } catch (e) {
    return { status: 'error', detail: messageOf(e) };
  }
}

/**
 * The live probe is the one check that costs money, and `/api/health` sits
 * behind no auth layer — so a loop over `curl '/api/health?live=1'` would bill
 * the user's provider account without bound. The answer is cached for a minute:
 * a human running `setup.sh --check` still gets a real round-trip (they are not
 * re-running it within the same minute), while a loop collapses to one call per
 * minute no matter how fast it spins.
 *
 * Cached on `globalThis` for the same reason the settings cache is — Next's dev
 * server re-evaluates modules, and a module-level variable would reset with it.
 */
const LIVE_PROBE_TTL_MS = 60_000;
const gLive = globalThis as unknown as { __mdmLiveProbe?: { at: number; result: Check } };

/** The key `getModel()` would use, resolved the same way it resolves it. Never
 *  reported — only used to redact itself out of a provider's error message. */
async function activeApiKey(): Promise<string | undefined> {
  try {
    const settings = await readLlmSettings();
    if (settings) return settings.apiKey;
    const provider = isProvider(process.env.LLM_PROVIDER) ? process.env.LLM_PROVIDER : 'openrouter';
    return process.env[ENV_FALLBACK[provider].keyVar];
  } catch {
    return undefined;
  }
}

/**
 * Spend one tiny completion to prove the key actually works. Opt-in only: this
 * costs money on every provider, so no UI polls it and no default call reaches it
 * — it exists for the moment a human asks "why doesn't my key work?".
 */
async function checkLlmLive(llm: Check): Promise<Check> {
  if (llm.status !== 'configured') return { status: 'skipped', detail: 'LLM not configured' };

  const cached = gLive.__mdmLiveProbe;
  if (cached && Date.now() - cached.at < LIVE_PROBE_TTL_MS) {
    const age = Math.round((Date.now() - cached.at) / 1000);
    // Say the answer is reused, so nobody reads a stale `reachable` as proof
    // that the key they just changed works.
    return { ...cached.result, detail: [cached.result.detail, `cached ${age}s ago`].filter(Boolean).join(' — ') };
  }
  // The key the probe is about to send. Held only to strip it back out of the
  // failure message: providers (and any user-supplied OpenAI-compatible baseUrl)
  // can echo the submitted key in their rejection body, and this detail travels
  // to an unauthenticated endpoint.
  const sentKey = await activeApiKey();
  try {
    const model = await getModel();
    await generateText({ model, prompt: 'Reply with the single word: ok', maxOutputTokens: 4 });
    return remember({ status: 'reachable' });
  } catch (e) {
    const msg = messageOf(e, [sentKey]);
    // Providers word key rejection very differently — OpenRouter answers a bad key
    // with a bare "User not found.", which carries no status code and no mention
    // of a key. Matching only the obvious phrasings mislabels the single most
    // common failure as a generic error, so the known provider wordings are
    // listed explicitly.
    const isAuth = /401|403|unauthor|(invalid|incorrect|missing).*(api.?key|token)|authentication|user not found|no auth credentials/i.test(msg);
    // Failures are cached too: a wrong key retried in a loop costs the provider
    // a rejection per call, and rate limits are enforced on failures as well.
    return remember({ status: isAuth ? 'auth_failed' : 'error', detail: msg });
  }
}

function remember(result: Check): Check {
  gLive.__mdmLiveProbe = { at: Date.now(), result };
  return result;
}

/** The embedding model is bundled and runs locally, but the first call loads it
 *  into memory and can outlast a health request on a cold container. A slow first
 *  load is not a broken install, so it reports `loading` rather than `error`. */
async function checkEmbeddings(timeoutMs: number): Promise<Check> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      embed('health check').then(() => 'done' as const),
      new Promise<'timeout'>((resolve) => { timer = setTimeout(() => resolve('timeout'), timeoutMs); }),
    ]);
    if (result === 'timeout') {
      return { status: 'loading', detail: `still loading after ${timeoutMs}ms — re-run the check shortly` };
    }
    return { status: 'ok' };
  } catch (e) {
    return { status: 'error', detail: messageOf(e) };
  } finally {
    // Without this a fast embed still pins a 10s timer per health request.
    if (timer) clearTimeout(timer);
  }
}

/** The one-click demo writes a SQLite file here; a read-only mount turns the demo
 *  button into a dead end, which is a bad first impression to discover by clicking. */
function checkDemoDir(): Check {
  const dir = path.resolve(process.cwd(), '.demo');
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.accessSync(dir, fs.constants.W_OK);
    return { status: 'ok' };
  } catch (e) {
    return { status: 'readonly', detail: messageOf(e) };
  }
}

export interface HealthOptions {
  /** Spend a token proving the LLM key works. Off by default — it costs money. */
  live?: boolean;
  /** How long to wait for the local embedding model before calling it `loading`. */
  embeddingTimeoutMs?: number;
}

export async function getSetupHealth({ live = false, embeddingTimeoutMs = 10_000 }: HealthOptions = {}): Promise<SetupHealth> {
  const [appDb, migrations, llm, embeddings] = await Promise.all([
    checkAppDb(),
    checkMigrations(),
    checkLlm(),
    checkEmbeddings(embeddingTimeoutMs),
  ]);
  const demoDir = checkDemoDir();
  const llmLive = live ? await checkLlmLive(llm) : { status: 'skipped' as const, detail: 'pass live=1 to test the key' };

  const checks = { appDb, migrations, llm, llmLive, embeddings, demoDir };
  const degraded = Object.values(checks).some((c) => !HEALTHY.has(c.status));
  return { status: degraded ? 'degraded' : 'ok', checks };
}
