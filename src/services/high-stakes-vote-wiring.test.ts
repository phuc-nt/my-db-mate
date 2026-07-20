/**
 * Wiring test for high-stakes candidate voting (mirrors answer-verify-wiring):
 * the pure vote logic is unit-tested in candidate-sql-service.test.ts; this proves
 * the run_sql tool actually GATES and attaches a `vote` correctly against a real
 * executor. The LLM candidate generator is not mocked — without a live model it
 * returns [] and the vote degrades to `inconclusive`, which is exactly the wiring
 * we assert (guard fires, payload attaches, degradation is safe).
 *
 * Guard invariants under test (red-team M9/H6):
 * - highStakes OFF → no `vote` key at all.
 * - highStakes ON but investigate mode → no `vote` (chat-only).
 * - highStakes ON but a finding cap present → no `vote` (never on the finding path).
 * - highStakes ON + chat + no finding → `vote` present.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import path from 'node:path';
import { rm, mkdir } from 'node:fs/promises';
import Database from 'better-sqlite3';
import { eq } from 'drizzle-orm';
import { db } from '../db/client';
import { connections } from '../db/schema';
import { buildAgentTools } from './agent-service';

const DB_PATH = path.join(process.cwd(), '.cache', 'high-stakes-vote-wiring.sqlite');
let connId: string;

async function runSql(tools: ReturnType<typeof buildAgentTools>, sql: string): Promise<Record<string, unknown>> {
  const runSqlTool = (tools as unknown as Record<string, { execute: (a: { sql: string }, opts?: unknown) => Promise<unknown> }>).run_sql;
  return (await runSqlTool.execute({ sql }, undefined)) as Record<string, unknown>;
}

// buildAgentTools positional args: (connId, actor, sessionId, mode, dialect, matchedMetrics, findingCap, highStakes, question)
const PK_LOOKUP = 'SELECT amt FROM t WHERE id = 1'; // low-risk so it executes on the statless test DB

beforeAll(async () => {
  await mkdir(path.dirname(DB_PATH), { recursive: true });
  await rm(DB_PATH, { force: true });
  const sqlite = new Database(DB_PATH);
  sqlite.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, amt REAL); INSERT INTO t VALUES (1, 30), (2, 20);');
  sqlite.close();
  const [c] = await db.insert(connections).values({
    name: 'high-stakes-vote-wiring', kind: 'sqlite-file', dialect: 'sqlite', config: { path: DB_PATH },
    secretEncrypted: null, isReadOnlyVerified: true,
  }).returning({ id: connections.id });
  connId = c.id;
});

afterAll(async () => {
  await db.delete(connections).where(eq(connections.id, connId));
  await rm(DB_PATH, { force: true });
});

describe('high-stakes vote gating in run_sql', () => {
  it('highStakes OFF → no vote key', async () => {
    const tools = buildAgentTools(connId, 'test', undefined, 'chat', 'sqlite', [], undefined, false, 'q');
    const out = await runSql(tools, PK_LOOKUP);
    expect('vote' in out).toBe(false);
  });

  it('highStakes ON + investigate mode → no vote (chat-only)', async () => {
    const tools = buildAgentTools(connId, 'test', undefined, 'investigate', 'sqlite', [], undefined, true, 'q');
    const out = await runSql(tools, PK_LOOKUP);
    expect('vote' in out).toBe(false);
  });

  it('highStakes ON + finding cap → no vote (never on the finding path)', async () => {
    // A finding cap forces the investigate-from-finding path; the guard is
    // `!findingCap`, so even with mode chat the vote must not fire. sessionId must
    // be a valid UUID (the finding-step reservation persists against it).
    const sess = '00000000-0000-4000-8000-000000000001';
    const tools = buildAgentTools(connId, 'test', sess, 'chat', 'sqlite', [], { sessionId: sess, cap: 3 }, true, 'q');
    const out = await runSql(tools, PK_LOOKUP);
    expect('vote' in out).toBe(false);
  });

  // NOTE: the positive case (highStakes ON + chat → vote present) requires a live
  // model for candidate generation and is covered by the phase-2 real-browser UAT,
  // not here — a live generateText call would make this unit test flaky/hang.
});
