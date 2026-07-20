/**
 * Wiring test (red-team H1): the per-sub SQL cap is RUNTIME-enforced, not just a
 * shape. Builds the agent tools with the `sub` override and drives run_sql past
 * the cap, asserting the tool returns `stopped` once the slice is spent — proving
 * the override actually gates (a no-op cap, the H1 trap, would let every call run).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import path from 'node:path';
import { rm, mkdir } from 'node:fs/promises';
import Database from 'better-sqlite3';
import { eq } from 'drizzle-orm';
import { db } from '../db/client';
import { connections } from '../db/schema';
import { buildAgentTools } from './agent-service';

const DB_PATH = path.join(process.cwd(), '.cache', 'sub-cap-wiring.sqlite');
let connId: string;

async function runSql(tools: ReturnType<typeof buildAgentTools>, sql: string): Promise<Record<string, unknown>> {
  const t = (tools as unknown as Record<string, { execute: (a: { sql: string }, opts?: unknown) => Promise<unknown> }>).run_sql;
  return (await t.execute({ sql }, undefined)) as Record<string, unknown>;
}

beforeAll(async () => {
  await mkdir(path.dirname(DB_PATH), { recursive: true });
  await rm(DB_PATH, { force: true });
  const sqlite = new Database(DB_PATH);
  sqlite.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, amt REAL); INSERT INTO t VALUES (1, 30), (2, 20), (3, 10);');
  sqlite.close();
  const [c] = await db.insert(connections).values({
    name: 'sub-cap-wiring', kind: 'sqlite-file', dialect: 'sqlite', config: { path: DB_PATH },
    secretEncrypted: null, isReadOnlyVerified: true,
  }).returning({ id: connections.id });
  connId = c.id;
});

afterAll(async () => {
  await db.delete(connections).where(eq(connections.id, connId));
  await rm(DB_PATH, { force: true });
});

describe('sub-investigation SQL cap is runtime-enforced (H1)', () => {
  it('stops run_sql after the per-sub cap of low-risk queries', async () => {
    // buildAgentTools positional: (conn, actor, sessionId, mode, dialect, metrics, findingCap, highStakes, question, sub)
    // sub cap = 2 → the 3rd low-risk run_sql must return `stopped`.
    const tools = buildAgentTools(connId, 'owner', undefined, 'investigate', 'sqlite', [], undefined, false, '', { maxSql: 2 });
    const pk = 'SELECT amt FROM t WHERE id = 1'; // low-risk → executes on the statless test DB

    const r1 = await runSql(tools, pk);
    const r2 = await runSql(tools, pk);
    const r3 = await runSql(tools, pk);

    expect(r1.stopped).toBeUndefined();
    expect(r2.stopped).toBeUndefined();
    expect(r3.stopped).toBe(true); // cap hit — the override actually gates (not a no-op)
    expect(String(r3.reason)).toMatch(/budget/i);
  });

  it('sub tools exclude plan_analysis and ask_user, keep detect_anomalies', () => {
    const tools = buildAgentTools(connId, 'owner', undefined, 'investigate', 'sqlite', [], undefined, false, '', { maxSql: 5 });
    const names = Object.keys(tools);
    expect(names).not.toContain('plan_analysis');
    expect(names).not.toContain('ask_user');
    expect(names).toContain('detect_anomalies');
    expect(names).toContain('run_sql');
  });

  it('a normal investigate loop (no sub) KEEPS plan_analysis + ask_user', () => {
    const tools = buildAgentTools(connId, 'owner', undefined, 'investigate', 'sqlite', []);
    const names = Object.keys(tools);
    expect(names).toContain('plan_analysis');
    expect(names).toContain('ask_user');
  });
});
