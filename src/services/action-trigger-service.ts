/**
 * Action triggers v1 — conditional webhook-out on findings.
 *
 * "When a monitor finding / digest change matches CONDITION, POST a templated
 * JSON payload to a webhook." Closes detect → act while keeping the app's core
 * read-only promise intact: this module never imports a connection provider or
 * any query-execution API — the ONLY outbound side effect is an SSRF-guarded
 * HTTP POST (grep-provable).
 *
 * Design decisions (plan 260718-0654-action-triggers-webhook-out):
 * - Conditions are a deterministic enum + threshold, NOT a user expression
 *   language (injection surface + needless complexity for v1).
 * - Payload templates substitute FIXED placeholders only, each JSON-escaped;
 *   the rendered body must JSON.parse or the fire is recorded as
 *   template_error and never sent.
 * - Rate limit is a sliding 1-hour window counted from the audit table; beyond
 *   it fires are recorded as suppressed (visible, not silently dropped).
 * - Delivery failures never fail the schedule run that produced the finding.
 */
import { and, desc, eq, gte, lt, sql as dsql } from 'drizzle-orm';
import { db } from '../db/client';
import { actionTriggers, actionTriggerFires, type TriggerCondition } from '../db/action-trigger-schema';
import { vetWebhookUrl } from './schedule-service';

/** Normalized finding shape shared by both surfaces: monitor rows carry
 *  table+metric, digest lines carry the metric name. */
export interface TriggerFinding {
  /** monitor: watched table · digest: metric name */
  name: string;
  /** monitor: 'rowCount' | 'nullRate:col' | 'avg:col' · digest: change flags joined */
  detail: string;
  before?: number | null;
  after?: number | null;
  deltaPct?: number | null;
}

const FIRE_RETENTION_DAYS = 90;

// ---------------------------------------------------------------------------
// CRUD (validation at save: condition shape + webhook vet + template render)
// ---------------------------------------------------------------------------

export function validateCondition(c: unknown): TriggerCondition {
  const b = c as Partial<TriggerCondition> | null;
  if (!b || (b.surface !== 'monitor' && b.surface !== 'digest')) throw new Error('condition.surface must be monitor|digest');
  if (b.kind !== 'any' && b.kind !== 'name-match' && b.kind !== 'delta-threshold') throw new Error('condition.kind must be any|name-match|delta-threshold');
  if (b.kind === 'name-match' && !(typeof b.tableOrMetric === 'string' && b.tableOrMetric.trim())) throw new Error('name-match needs tableOrMetric');
  if (b.kind === 'delta-threshold' && !(typeof b.threshold === 'number' && Number.isFinite(b.threshold) && b.threshold > 0)) throw new Error('delta-threshold needs a positive threshold');
  return {
    surface: b.surface,
    kind: b.kind,
    ...(typeof b.tableOrMetric === 'string' && b.tableOrMetric.trim() ? { tableOrMetric: b.tableOrMetric.trim() } : {}),
    ...(b.kind === 'delta-threshold' ? { threshold: b.threshold } : {}),
  };
}

export async function createTrigger(input: {
  connectionId: string; name: string; condition: unknown; webhookUrl: string;
  payloadTemplate?: string; rateLimitPerHour?: number;
}) {
  const condition = validateCondition(input.condition);
  if (!input.name.trim()) throw new Error('name required');
  const vet = await vetWebhookUrl(input.webhookUrl);
  if (!vet.ok) throw new Error(`webhook rejected: ${vet.reason}`);
  const template = input.payloadTemplate?.trim() || DEFAULT_TEMPLATE;
  assertTemplateRenders(template);
  const rate = input.rateLimitPerHour ?? 10;
  if (!Number.isInteger(rate) || rate < 1 || rate > 1000) throw new Error('rateLimitPerHour must be 1-1000');
  const [row] = await db.insert(actionTriggers).values({
    connectionId: input.connectionId, name: input.name.trim(), condition,
    webhookUrl: input.webhookUrl, payloadTemplate: template, rateLimitPerHour: rate,
  }).returning();
  return row;
}

export async function updateTrigger(id: string, patch: { name?: string; isEnabled?: boolean; condition?: unknown; webhookUrl?: string; payloadTemplate?: string; rateLimitPerHour?: number }) {
  const set: Record<string, unknown> = {};
  if (patch.name !== undefined) { if (!patch.name.trim()) throw new Error('name required'); set.name = patch.name.trim(); }
  if (patch.isEnabled !== undefined) set.isEnabled = patch.isEnabled;
  if (patch.condition !== undefined) set.condition = validateCondition(patch.condition);
  if (patch.webhookUrl !== undefined) {
    const vet = await vetWebhookUrl(patch.webhookUrl);
    if (!vet.ok) throw new Error(`webhook rejected: ${vet.reason}`);
    set.webhookUrl = patch.webhookUrl;
  }
  if (patch.payloadTemplate !== undefined) { assertTemplateRenders(patch.payloadTemplate); set.payloadTemplate = patch.payloadTemplate; }
  if (patch.rateLimitPerHour !== undefined) {
    if (!Number.isInteger(patch.rateLimitPerHour) || patch.rateLimitPerHour < 1 || patch.rateLimitPerHour > 1000) throw new Error('rateLimitPerHour must be 1-1000');
    set.rateLimitPerHour = patch.rateLimitPerHour;
  }
  const [row] = await db.update(actionTriggers).set(set).where(eq(actionTriggers.id, id)).returning();
  if (!row) throw new Error('trigger not found');
  return row;
}

export async function deleteTrigger(id: string) {
  await db.delete(actionTriggers).where(eq(actionTriggers.id, id));
}

export async function listTriggers(connectionId: string) {
  return db.select().from(actionTriggers).where(eq(actionTriggers.connectionId, connectionId)).orderBy(actionTriggers.createdAt);
}

export async function listFires(triggerId: string, limit = 20) {
  return db.select().from(actionTriggerFires).where(eq(actionTriggerFires.triggerId, triggerId))
    .orderBy(desc(actionTriggerFires.firedAt)).limit(limit);
}

/** Fires for a trigger, scoped to a connection — so the fire-history endpoint
 *  can't read another connection's trigger via a guessed id (latent authz gap if
 *  auth is ever added; harmless under the current single-user model). */
export async function listFiresForConnection(connectionId: string, triggerId: string, limit = 20) {
  const [t] = await db.select({ id: actionTriggers.id }).from(actionTriggers)
    .where(and(eq(actionTriggers.id, triggerId), eq(actionTriggers.connectionId, connectionId)));
  if (!t) return [];
  return listFires(triggerId, limit);
}

// ---------------------------------------------------------------------------
// Matching + payload rendering (pure)
// ---------------------------------------------------------------------------

export function matchesCondition(c: TriggerCondition, surface: 'monitor' | 'digest', f: TriggerFinding): boolean {
  if (c.surface !== surface) return false;
  if (c.tableOrMetric && c.tableOrMetric.toLowerCase() !== f.name.toLowerCase()) return false;
  switch (c.kind) {
    case 'any': return true;
    case 'name-match': return true; // the name filter above IS the condition
    case 'delta-threshold': return f.deltaPct != null && Math.abs(f.deltaPct) >= (c.threshold ?? Infinity);
  }
}

export const DEFAULT_TEMPLATE = JSON.stringify({
  trigger: '{{trigger.name}}',
  connection: '{{connection.name}}',
  finding: { name: '{{finding.name}}', detail: '{{finding.detail}}', before: '{{finding.before}}', after: '{{finding.after}}', deltaPct: '{{finding.deltaPct}}' },
}, null, 2);

/** Substitute the FIXED placeholder set into a JSON template. Every value is
 *  JSON-string-escaped before insertion (a finding name containing `"` or a
 *  newline cannot break out of its string), and the result must parse. */
export function renderPayload(template: string, ctx: { trigger: string; connection: string; finding: TriggerFinding; test?: boolean }): string {
  const esc = (v: unknown) => JSON.stringify(v == null ? '' : String(v)).slice(1, -1);
  const rendered = template
    .replaceAll('{{trigger.name}}', esc(ctx.trigger))
    .replaceAll('{{connection.name}}', esc(ctx.connection))
    .replaceAll('{{finding.name}}', esc(ctx.finding.name))
    .replaceAll('{{finding.detail}}', esc(ctx.finding.detail))
    .replaceAll('{{finding.before}}', esc(ctx.finding.before))
    .replaceAll('{{finding.after}}', esc(ctx.finding.after))
    .replaceAll('{{finding.deltaPct}}', esc(ctx.finding.deltaPct));
  const parsed = JSON.parse(rendered) as Record<string, unknown>; // throws → template_error upstream
  if (ctx.test) parsed._test = true;
  return JSON.stringify(parsed);
}

/** Save-time check: the template must render valid JSON with a benign sample. */
function assertTemplateRenders(template: string): void {
  try {
    renderPayload(template, { trigger: 't', connection: 'c', finding: { name: 'n', detail: 'd', before: 1, after: 2, deltaPct: 3 } });
  } catch {
    throw new Error('payload template must be valid JSON using only the documented {{placeholders}}');
  }
}

// ---------------------------------------------------------------------------
// Evaluation + delivery (called from the monitor/digest pipelines)
// ---------------------------------------------------------------------------

/** Count non-suppressed fire attempts in the sliding 1-hour window. */
async function firesInLastHour(triggerId: string): Promise<number> {
  const cutoff = new Date(Date.now() - 3600_000);
  const rows = await db.select({ n: dsql<number>`count(*)` }).from(actionTriggerFires)
    .where(and(
      eq(actionTriggerFires.triggerId, triggerId),
      gte(actionTriggerFires.firedAt, cutoff),
      dsql`${actionTriggerFires.status} <> 'suppressed'`,
    ));
  return Number(rows[0]?.n ?? 0);
}

async function recordFire(triggerId: string, status: string, extra: { httpStatus?: number; error?: string; findingSnapshot?: Record<string, unknown> }) {
  await db.insert(actionTriggerFires).values({ triggerId, status, ...extra });
  // Age-based prune (mirrors monitor snapshot retention).
  const cutoff = new Date(Date.now() - FIRE_RETENTION_DAYS * 24 * 3600_000);
  await db.delete(actionTriggerFires).where(and(eq(actionTriggerFires.triggerId, triggerId), lt(actionTriggerFires.firedAt, cutoff)));
}

/** Deliver one payload. SSRF re-vetted at fire time (DNS may have changed since
 *  save). Never throws — every outcome lands in the audit table. */
async function deliver(triggerId: string, url: string, body: string, snapshot: Record<string, unknown>): Promise<void> {
  const vet = await vetWebhookUrl(url);
  if (!vet.ok) { await recordFire(triggerId, 'blocked', { error: `webhook blocked: ${vet.reason}`, findingSnapshot: snapshot }); return; }
  try {
    const res = await fetch(url, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body,
      redirect: 'manual', signal: AbortSignal.timeout(10_000),
    });
    if (res.status >= 300 && res.status < 400) {
      await recordFire(triggerId, 'failed', { httpStatus: res.status, error: 'webhook redirected (not followed for SSRF safety)', findingSnapshot: snapshot });
      return;
    }
    await recordFire(triggerId, res.ok ? 'delivered' : 'failed', { httpStatus: res.status, ...(res.ok ? {} : { error: `HTTP ${res.status}` }), findingSnapshot: snapshot });
  } catch (e) {
    await recordFire(triggerId, 'failed', { error: e instanceof Error ? e.message : String(e), findingSnapshot: snapshot });
  }
}

/** Evaluate all enabled triggers of a connection against a run's findings.
 *  Called AFTER the monitor/digest pipeline computed its findings — inside its
 *  own try/catch there, so a trigger problem can never fail the run. */
export async function evaluateTriggers(
  connectionId: string,
  surface: 'monitor' | 'digest',
  findings: TriggerFinding[],
  connectionName: string,
): Promise<void> {
  if (findings.length === 0) return;
  const triggers = (await listTriggers(connectionId)).filter((t) => t.isEnabled);
  for (const t of triggers) {
    const matched = findings.filter((f) => matchesCondition(t.condition, surface, f));
    for (const f of matched) {
      const snapshot = { surface, ...f } as Record<string, unknown>;
      if ((await firesInLastHour(t.id)) >= t.rateLimitPerHour) {
        await recordFire(t.id, 'suppressed', { error: `rate limit (${t.rateLimitPerHour}/h) reached`, findingSnapshot: snapshot });
        continue;
      }
      let body: string;
      try {
        body = renderPayload(t.payloadTemplate, { trigger: t.name, connection: connectionName, finding: f });
      } catch {
        await recordFire(t.id, 'template_error', { error: 'template did not render valid JSON', findingSnapshot: snapshot });
        continue;
      }
      await deliver(t.id, t.webhookUrl, body, snapshot);
    }
  }
}

/** Manual test fire: a clearly-marked sample payload through the full path. */
export async function testFire(triggerId: string, connectionName: string): Promise<{ ok: boolean; detail: string }> {
  const [t] = await db.select().from(actionTriggers).where(eq(actionTriggers.id, triggerId));
  if (!t) return { ok: false, detail: 'trigger not found' };
  const sample: TriggerFinding = { name: 'sample_table', detail: 'rowCount', before: 1000, after: 1350, deltaPct: 35 };
  let body: string;
  try {
    body = renderPayload(t.payloadTemplate, { trigger: t.name, connection: connectionName, finding: sample, test: true });
  } catch {
    await recordFire(t.id, 'template_error', { error: 'template did not render valid JSON (test)' });
    return { ok: false, detail: 'template did not render valid JSON' };
  }
  await deliver(t.id, t.webhookUrl, body, { test: true, ...sample });
  const [last] = await listFires(t.id, 1);
  return { ok: last?.status === 'delivered', detail: `${last?.status}${last?.httpStatus ? ` (HTTP ${last.httpStatus})` : ''}${last?.error ? ` — ${last.error}` : ''}` };
}
