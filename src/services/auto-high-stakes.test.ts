/**
 * P2 auto-trigger tests.
 *
 * Part 1 — decideHighStakesMode guard matrix (pure, red-team H1/tests a-f):
 * the auto path fires ONLY for the interactive chat route (allowAuto), in plain
 * chat mode, off the finding path, with the kill-switch open, on a close metric
 * match. Headless callers (MCP/schedule/eval) never pass allowAuto.
 *
 * Part 2 — first-run_sql-only (M1, test g): with the candidate generator mocked
 * (no live model), an 'auto' turn attaches a vote to the FIRST successful
 * run_sql and none after; the manual toggle keeps voting every run.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import path from 'node:path';
import { rm, mkdir } from 'node:fs/promises';
import Database from 'better-sqlite3';
import { eq } from 'drizzle-orm';

vi.mock('./candidate-sql-service', async (importOriginal) => {
  const orig = await importOriginal<typeof import('./candidate-sql-service')>();
  return { ...orig, generateCandidateSqls: vi.fn().mockResolvedValue([]) };
});

import { db } from '@/core/db/client';
import { connections } from '@/core/db/schema';
import { buildAgentTools, decideHighStakesMode } from './agent-service';

describe('decideHighStakesMode — guard matrix (H1)', () => {
  const base = { manual: false, allowAuto: true, mode: 'chat' as const, hasFindingCap: false, metricDistances: [0.2], envOff: false };

  it('(a) chat + close metric + allowAuto → auto', () => {
    expect(decideHighStakesMode(base)).toBe('auto');
  });
  it('(b) metric distance above the lint floor → no auto', () => {
    expect(decideHighStakesMode({ ...base, metricDistances: [0.3] })).toBe(false);
  });
  it('(c) env kill-switch → no auto', () => {
    expect(decideHighStakesMode({ ...base, envOff: true })).toBe(false);
  });
  it('(d) investigate / finding path → never, even with manual toggle', () => {
    expect(decideHighStakesMode({ ...base, mode: 'investigate' })).toBe(false);
    expect(decideHighStakesMode({ ...base, hasFindingCap: true })).toBe(false);
    expect(decideHighStakesMode({ ...base, manual: true, mode: 'investigate' })).toBe(false);
  });
  it('(e) manual toggle wins regardless of metric match', () => {
    expect(decideHighStakesMode({ ...base, manual: true, metricDistances: [] })).toBe(true);
  });
  it('(f) headless caller (no allowAuto) + close metric → no auto (H1)', () => {
    expect(decideHighStakesMode({ ...base, allowAuto: false })).toBe(false);
  });
});

const DB_PATH = path.join(process.cwd(), '.cache', 'auto-high-stakes.sqlite');
let connId: string;

async function runSql(tools: ReturnType<typeof buildAgentTools>, sql: string): Promise<Record<string, unknown>> {
  const t = (tools as unknown as Record<string, { execute: (a: { sql: string }, o?: unknown) => Promise<unknown> }>).run_sql;
  return (await t.execute({ sql }, undefined)) as Record<string, unknown>;
}
const PK = 'SELECT amt FROM t WHERE id = 1'; // low-risk → executes on the statless test DB

beforeAll(async () => {
  await mkdir(path.dirname(DB_PATH), { recursive: true });
  await rm(DB_PATH, { force: true });
  const s = new Database(DB_PATH);
  s.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, amt REAL); INSERT INTO t VALUES (1, 30), (2, 20);');
  s.close();
  const [c] = await db.insert(connections).values({
    name: 'auto-high-stakes-wiring', kind: 'sqlite-file', dialect: 'sqlite', config: { path: DB_PATH },
    secretEncrypted: null, isReadOnlyVerified: true,
  }).returning({ id: connections.id });
  connId = c.id;
});

afterAll(async () => {
  await db.delete(connections).where(eq(connections.id, connId));
  await rm(DB_PATH, { force: true });
});

describe('auto votes only the first successful run_sql (M1, test g)', () => {
  it("'auto': first run gets a vote (marked auto), second gets none", async () => {
    const tools = buildAgentTools(connId, 'test', undefined, 'chat', 'sqlite', [], undefined, 'auto', 'total amount');
    const r1 = await runSql(tools, PK);
    const r2 = await runSql(tools, PK);
    expect(r1.vote).toBeTruthy();
    expect((r1.vote as { auto?: boolean }).auto).toBe(true);
    expect('vote' in r2).toBe(false);
  });

  it('manual toggle keeps voting every run (no auto marker)', async () => {
    const tools = buildAgentTools(connId, 'test', undefined, 'chat', 'sqlite', [], undefined, true, 'total amount');
    const r1 = await runSql(tools, PK);
    const r2 = await runSql(tools, PK);
    expect(r1.vote).toBeTruthy();
    expect(r2.vote).toBeTruthy();
    expect((r1.vote as { auto?: boolean }).auto).toBeUndefined();
  });
});
