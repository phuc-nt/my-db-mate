/**
 * Wiring test (red-team F5): the pure checks are unit-tested elsewhere; this
 * proves the run_sql tool ACTUALLY attaches verifyChecks against a real executor
 * (the V2/V3 lesson — pure tests + no wiring test = wiring bugs ship). Builds the
 * agent tools on a real SQLite connection and calls run_sql.execute directly.
 *
 * Queries use a PK-indexed lookup so the risk gate rates them low and they
 * actually execute (a full-scan aggregate on a tiny statless test table escalates
 * to needs_confirmation and never reaches the verify hook — an artifact of the
 * test DB, not the feature).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import path from 'node:path';
import { rm, mkdir } from 'node:fs/promises';
import Database from 'better-sqlite3';
import { eq } from 'drizzle-orm';
import { db } from '../db/client';
import { connections } from '../db/schema';
import { buildAgentTools, type MatchedMetric } from './agent-service';

const DB_PATH = path.join(process.cwd(), '.cache', 'answer-verify-wiring.sqlite');
let connId: string;

// The AI SDK tool type is elaborate; for the test we only need run_sql.execute.
async function runSql(tools: ReturnType<typeof buildAgentTools>, sql: string): Promise<Record<string, unknown>> {
  const runSqlTool = (tools as unknown as Record<string, { execute: (a: { sql: string }, opts?: unknown) => Promise<unknown> }>).run_sql;
  return (await runSqlTool.execute({ sql }, undefined)) as Record<string, unknown>;
}
const freshMetric = (latest: number): MatchedMetric => ({
  name: 'M', sql: 'x', distance: 0.1, timeGrain: 'month',
  lastRun: { latest, prev: latest, deltaPct: null, latestT: '2026-07' }, lastRunAt: new Date(),
});

beforeAll(async () => {
  await mkdir(path.dirname(DB_PATH), { recursive: true });
  await rm(DB_PATH, { force: true });
  const sqlite = new Database(DB_PATH);
  sqlite.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, amt REAL); INSERT INTO t VALUES (1, 30), (2, 20);');
  sqlite.close();
  const [c] = await db.insert(connections).values({
    name: 'answer-verify-wiring', kind: 'sqlite-file', dialect: 'sqlite', config: { path: DB_PATH },
    secretEncrypted: null, isReadOnlyVerified: true,
  }).returning({ id: connections.id });
  connId = c.id;
});

afterAll(async () => {
  await db.delete(connections).where(eq(connections.id, connId));
  await rm(DB_PATH, { force: true });
});

const magOf = (out: Record<string, unknown>) =>
  (out.verifyChecks as { id: string; status: string }[] | undefined)?.find((c) => c.id === 'metric-magnitude');

describe('run_sql attaches verifyChecks in chat mode', () => {
  it('a wildly-different magnitude vs the metric cache → warn + verifyHint', async () => {
    // metric latest ~0.3; the answer 30 is 100× → warn.
    const tools = buildAgentTools(connId, 'test', undefined, 'chat', 'sqlite', [freshMetric(0.3)]);
    const out = await runSql(tools, 'SELECT amt FROM t WHERE id = 1'); // → 30
    expect(Array.isArray(out.verifyChecks)).toBe(true);
    expect(magOf(out)?.status).toBe('warn');
    expect(typeof out.verifyHint).toBe('string');
  });

  it('a right-sized number → pass, no verifyHint', async () => {
    const tools = buildAgentTools(connId, 'test', undefined, 'chat', 'sqlite', [freshMetric(30)]);
    const out = await runSql(tools, 'SELECT amt FROM t WHERE id = 1'); // 30 ≈ 30
    expect(magOf(out)?.status).toBe('pass');
    expect(out.verifyHint).toBeUndefined();
  });

  it('investigate mode does NOT attach verifyChecks (chat-only)', async () => {
    const tools = buildAgentTools(connId, 'test', undefined, 'investigate', 'sqlite', []);
    const out = await runSql(tools, 'SELECT amt FROM t WHERE id = 1');
    expect(out.verifyChecks).toBeUndefined();
  });

  it('stale lastRun (>48h) → metric check skips (no false trust on old data)', async () => {
    const stale: MatchedMetric = { ...freshMetric(0.3), lastRunAt: new Date(Date.now() - 72 * 3600_000) };
    const tools = buildAgentTools(connId, 'test', undefined, 'chat', 'sqlite', [stale]);
    const out = await runSql(tools, 'SELECT amt FROM t WHERE id = 1');
    expect(magOf(out)?.status).toBe('skip');
  });
});
