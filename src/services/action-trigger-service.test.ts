/**
 * Action-trigger tests. Pure logic (match/render/condition validation) needs no
 * DB; the fire/rate-limit/delivery paths run DB-backed with a mocked fetch.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '../db/client';
import { connections } from '../db/schema';
import { actionTriggers, actionTriggerFires } from '../db/action-trigger-schema';
import { encryptSecret } from './crypto/credential-cipher';
import {
  validateCondition, matchesCondition, renderPayload, DEFAULT_TEMPLATE,
  createTrigger, evaluateTriggers, testFire, listFires, listFiresForConnection, type TriggerFinding,
} from './action-trigger-service';

describe('validateCondition', () => {
  it('accepts the three kinds and rejects malformed input', () => {
    expect(validateCondition({ surface: 'monitor', kind: 'any' }).kind).toBe('any');
    expect(validateCondition({ surface: 'digest', kind: 'name-match', tableOrMetric: 'Revenue' }).tableOrMetric).toBe('Revenue');
    expect(validateCondition({ surface: 'monitor', kind: 'delta-threshold', threshold: 20 }).threshold).toBe(20);
    expect(() => validateCondition({ surface: 'x', kind: 'any' })).toThrow('surface');
    expect(() => validateCondition({ surface: 'monitor', kind: 'zzz' })).toThrow('kind');
    expect(() => validateCondition({ surface: 'monitor', kind: 'name-match' })).toThrow('tableOrMetric');
    expect(() => validateCondition({ surface: 'monitor', kind: 'delta-threshold', threshold: -5 })).toThrow('threshold');
  });
});

describe('matchesCondition', () => {
  const f: TriggerFinding = { name: 'orders', detail: 'rowCount', deltaPct: 35 };
  it('filters by surface, name, and delta threshold', () => {
    expect(matchesCondition({ surface: 'monitor', kind: 'any' }, 'monitor', f)).toBe(true);
    expect(matchesCondition({ surface: 'monitor', kind: 'any' }, 'digest', f)).toBe(false);
    expect(matchesCondition({ surface: 'monitor', kind: 'name-match', tableOrMetric: 'ORDERS' }, 'monitor', f)).toBe(true);
    expect(matchesCondition({ surface: 'monitor', kind: 'name-match', tableOrMetric: 'other' }, 'monitor', f)).toBe(false);
    expect(matchesCondition({ surface: 'monitor', kind: 'delta-threshold', threshold: 30 }, 'monitor', f)).toBe(true);
    expect(matchesCondition({ surface: 'monitor', kind: 'delta-threshold', threshold: 50 }, 'monitor', f)).toBe(false);
    expect(matchesCondition({ surface: 'monitor', kind: 'delta-threshold', threshold: 10 }, 'monitor', { name: 'x', detail: 'y' })).toBe(false); // no deltaPct
  });
});

describe('renderPayload', () => {
  it('substitutes placeholders and JSON-escapes injected values', () => {
    const out = renderPayload(DEFAULT_TEMPLATE, {
      trigger: 'T', connection: 'C',
      finding: { name: 'ord"ers\nX', detail: 'rowCount', before: 1000, after: 1350, deltaPct: 35 },
    });
    const obj = JSON.parse(out); // must parse despite the quote + newline in the value
    expect(obj.finding.name).toBe('ord"ers\nX');
    expect(obj.trigger).toBe('T');
    expect(obj.finding.deltaPct).toBe('35');
  });
  it('throws on a template that renders invalid JSON', () => {
    expect(() => renderPayload('{ not: {{finding.name}} }', { trigger: 't', connection: 'c', finding: { name: 'x', detail: 'd' } })).toThrow();
  });
});

// ---- DB-backed ----
let connectionId: string;
const fetchMock = vi.fn();
beforeEach(async () => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  process.env.WEBHOOK_PRIVATE_ALLOWLIST = 'hook.test:443';
  const [c] = await db.insert(connections).values({
    name: 'trig-conn', kind: 'postgres-driver', dialect: 'postgres',
    config: { host: 'localhost' }, secretEncrypted: encryptSecret('x'), isReadOnlyVerified: true,
  }).returning();
  connectionId = c.id;
});
afterEach(async () => {
  vi.unstubAllGlobals();
  await db.delete(connections).where(eq(connections.id, connectionId));
});

async function newTrigger(over?: Partial<{ rateLimitPerHour: number; condition: unknown }>) {
  return createTrigger({
    connectionId, name: 'r', webhookUrl: 'https://hook.test/x',
    condition: over?.condition ?? { surface: 'monitor', kind: 'any' },
    rateLimitPerHour: over?.rateLimitPerHour,
  });
}

describe('evaluateTriggers (DB-backed)', () => {
  it('fires a delivered webhook for a matching finding', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200 });
    const t = await newTrigger();
    await evaluateTriggers(connectionId, 'monitor', [{ name: 'orders', detail: 'rowCount', deltaPct: 35 }], 'trig-conn');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const fires = await listFires(t.id);
    expect(fires[0].status).toBe('delivered');
    expect(fires[0].httpStatus).toBe(200);
  });

  it('suppresses beyond the rate limit and records it', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200 });
    const t = await newTrigger({ rateLimitPerHour: 1 });
    const findings = [{ name: 'orders', detail: 'rowCount', deltaPct: 35 }, { name: 'items', detail: 'rowCount', deltaPct: 40 }];
    await evaluateTriggers(connectionId, 'monitor', findings, 'trig-conn');
    expect(fetchMock).toHaveBeenCalledTimes(1); // second is suppressed
    const fires = await listFires(t.id);
    expect(fires.map((f) => f.status).sort()).toEqual(['delivered', 'suppressed']);
  });

  it('records a delivery failure without throwing', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500 });
    const t = await newTrigger();
    await evaluateTriggers(connectionId, 'monitor', [{ name: 'orders', detail: 'rowCount', deltaPct: 35 }], 'trig-conn');
    const fires = await listFires(t.id);
    expect(fires[0].status).toBe('failed');
    expect(fires[0].httpStatus).toBe(500);
  });

  it('does not fire when the surface differs', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200 });
    await newTrigger({ condition: { surface: 'digest', kind: 'any' } });
    await evaluateTriggers(connectionId, 'monitor', [{ name: 'orders', detail: 'rowCount', deltaPct: 35 }], 'trig-conn');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('listFiresForConnection returns nothing for a trigger of another connection', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200 });
    const t = await newTrigger();
    await evaluateTriggers(connectionId, 'monitor', [{ name: 'orders', detail: 'rowCount', deltaPct: 35 }], 'trig-conn');
    expect((await listFiresForConnection(connectionId, t.id)).length).toBe(1);
    // A different (non-owning) connection id must not see this trigger's fires.
    expect((await listFiresForConnection('00000000-0000-0000-0000-0000000000aa', t.id)).length).toBe(0);
  });

  it('testFire delivers a clearly-marked sample payload', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200 });
    const t = await newTrigger();
    const r = await testFire(t.id, 'trig-conn');
    expect(r.ok).toBe(true);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body._test).toBe(true);
  });
});
