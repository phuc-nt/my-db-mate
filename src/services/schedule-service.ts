/**
 * Scheduled queries (P4). A recurring SQL or NL question runs on a cron, result
 * delivered to a webhook. Safety-critical properties (RT-F6/F8):
 *   - per-schedule concurrency lock (skip if the previous run is still active)
 *   - every run goes through query-executor (safety + risk + audit)
 *   - high-risk unattended runs are recorded as blocked, not silently executed
 *   - webhook egress blocks private/loopback IPs (SSRF guard)
 *   - every run (ok/skipped/blocked/error/delivery_failed) is recorded
 */
import cron, { type ScheduledTask } from 'node-cron';
import { eq } from 'drizzle-orm';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { db } from '../db/client';
import { scheduledQueries, scheduledRuns } from '../db/ecosystem-schema';
import { getConnection } from './connection-service';
import { executeQuery } from './query-executor-service';
import { runAgentAnswer } from './agent-service';

const tasks = new Map<string, ScheduledTask>();
const running = new Set<string>(); // concurrency lock per schedule id

/** True if an IP address string is private/loopback/link-local/ULA or a mapped
 *  form of one. Handles IPv4, IPv4-mapped IPv6 (::ffff:a.b.c.d), and IPv6. */
function isPrivateIp(ip: string): boolean {
  // Normalize IPv4-mapped IPv6 (::ffff:169.254.169.254) to its IPv4 form.
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  const v4 = mapped ? mapped[1] : (isIP(ip) === 4 ? ip : null);
  if (v4) {
    const [a, b] = v4.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a >= 224;
  }
  const lower = ip.toLowerCase();
  if (lower === '::1' || lower === '0:0:0:0:0:0:0:1') return true;              // loopback
  if (/^(fe8|fe9|fea|feb)/.test(lower)) return true;                            // link-local
  if (/^(fc|fd)/.test(lower)) return true;                                      // unique-local
  if (/^::ffff:/.test(lower)) return true;                                      // any other mapped → treat as private-ish, safer
  return false;
}

/**
 * SSRF guard: resolves the host and rejects if ANY resolved address is
 * private/loopback/link-local/metadata (code-review C1/C2). Also rejects
 * non-http(s), bare single-label hosts, and literal private IPs in any encoding.
 * Returns the vetted IP so the caller can pin it (prevents DNS rebinding).
 */
export async function vetWebhookUrl(raw: string): Promise<{ ok: boolean; pinnedIp?: string; reason?: string }> {
  let u: URL;
  try { u = new URL(raw); } catch { return { ok: false, reason: 'invalid URL' }; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return { ok: false, reason: 'protocol not http(s)' };
  const host = u.hostname.replace(/^\[|\]$/g, ''); // strip IPv6 brackets
  if (host === 'localhost') return { ok: false, reason: 'localhost' };
  if (!host.includes('.') && isIP(host) === 0) return { ok: false, reason: 'bare single-label host' };

  // Literal IP (any form isIP recognizes) → check directly.
  if (isIP(host) !== 0) {
    return isPrivateIp(host) ? { ok: false, reason: `private IP ${host}` } : { ok: true, pinnedIp: host };
  }
  // DNS name → resolve ALL addresses; reject if any is private (rebinding-safe).
  try {
    const addrs = await lookup(host, { all: true });
    if (addrs.length === 0) return { ok: false, reason: 'no DNS record' };
    for (const a of addrs) if (isPrivateIp(a.address)) return { ok: false, reason: `resolves to private ${a.address}` };
    return { ok: true, pinnedIp: addrs[0].address };
  } catch (e) {
    return { ok: false, reason: `DNS lookup failed: ${e instanceof Error ? e.message : e}` };
  }
}

async function record(scheduleId: string, status: string, detail?: string, rowCount?: number, result?: { columns: string[]; rows: unknown[][] }) {
  await db.insert(scheduledRuns).values({ scheduleId, status, detail: detail ?? null, rowCount: rowCount ?? null, result: result ?? null });
}

/** Execute one schedule now (used by the cron tick and manual "run now"). */
export async function runSchedule(scheduleId: string): Promise<void> {
  if (running.has(scheduleId)) { await record(scheduleId, 'skipped', 'previous run still active'); return; }
  running.add(scheduleId);
  try {
    const [s] = await db.select().from(scheduledQueries).where(eq(scheduledQueries.id, scheduleId));
    if (!s || !s.isEnabled) return;
    const conn = await getConnection(s.connectionId);
    if (!conn) { await record(scheduleId, 'error', 'connection not found'); return; }

    // Resolve SQL: deterministic sql, or ask the agent for a question then extract.
    let sql = s.sql ?? '';
    if (s.mode === 'question' && s.question) {
      const answer = await runAgentAnswer({ connectionId: s.connectionId, dialect: conn.dialect, question: s.question, actor: `schedule:${s.id}` });
      const m = /```sql\s*([\s\S]*?)```/i.exec(answer.text);
      sql = m ? m[1].trim() : '';
    }
    if (!sql) { await record(scheduleId, 'error', 'no SQL to run'); return; }

    // Through the choke point — unattended, so never confirm medium/high risk.
    const res = await executeQuery({ connectionId: s.connectionId, sql, actor: `schedule:${s.id}`, confirmed: false });
    if (res.status === 'blocked') { await record(scheduleId, 'blocked', res.blockedReason); return; }
    if (res.status === 'needs_confirmation') { await record(scheduleId, 'blocked', `medium/high risk, no one to confirm (unattended): ${res.risk?.reason}`); return; }
    if (res.status === 'error') { await record(scheduleId, 'error', res.errorMessage); return; }

    const result = { columns: res.result!.columns, rows: res.result!.rows };
    // Deliver.
    if (s.webhookUrl) {
      const vet = await vetWebhookUrl(s.webhookUrl);
      if (!vet.ok) { await record(scheduleId, 'delivery_failed', `webhook blocked: ${vet.reason}`, res.result!.rowCount, result); return; }
      try {
        // redirect:'manual' so a vetted public host can't 302 to a private one (H1).
        const wr = await fetch(s.webhookUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: s.name, ...result }), redirect: 'manual' });
        if (wr.status >= 300 && wr.status < 400) { await record(scheduleId, 'delivery_failed', 'webhook redirected (not followed for SSRF safety)', res.result!.rowCount, result); return; }
        if (!wr.ok) { await record(scheduleId, 'delivery_failed', `webhook status ${wr.status}`, res.result!.rowCount, result); return; }
      } catch (e) {
        await record(scheduleId, 'delivery_failed', String(e), res.result!.rowCount, result); return;
      }
    }
    await db.update(scheduledQueries).set({ lastRunAt: new Date() }).where(eq(scheduledQueries.id, scheduleId));
    await record(scheduleId, 'ok', undefined, res.result!.rowCount, result);
  } finally {
    running.delete(scheduleId);
  }
}

/** (Re)load all enabled schedules into node-cron. Call on boot. */
export async function loadSchedules(): Promise<void> {
  for (const t of tasks.values()) t.stop();
  tasks.clear();
  const rows = await db.select().from(scheduledQueries).where(eq(scheduledQueries.isEnabled, true));
  for (const s of rows) {
    if (!cron.validate(s.cron)) continue;
    // .catch so a runSchedule rejection never becomes an unhandled rejection (M3).
    const task = cron.schedule(s.cron, () => { runSchedule(s.id).catch((e) => console.error('scheduled run failed', s.id, e)); });
    tasks.set(s.id, task);
  }
}

export async function createSchedule(input: {
  connectionId: string; name: string; mode: 'sql' | 'question'; sql?: string; question?: string; cron: string; webhookUrl?: string;
}) {
  if (!cron.validate(input.cron)) throw new Error('invalid cron expression');
  if (input.webhookUrl) {
    const vet = await vetWebhookUrl(input.webhookUrl);
    if (!vet.ok) throw new Error(`webhook URL rejected: ${vet.reason}`);
  }
  const [row] = await db.insert(scheduledQueries).values(input).returning();
  await loadSchedules();
  return row;
}

export async function listSchedules(connectionId: string) {
  return db.select().from(scheduledQueries).where(eq(scheduledQueries.connectionId, connectionId));
}
