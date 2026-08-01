/**
 * Discard-tombstone semantics (hygiene item 2, rewritten per plan red-team C2):
 * - a tombstone blocks persisting a turn that STARTED at/before it (A4 H4);
 * - a turn starting AFTER the tombstone is never blocked (no clear needed for
 *   correctness — `at >= turnStartIso` already scopes it);
 * - consume-on-skip removes the metadata key once the skip fired, and ONLY then
 *   (clearing on a new POST would resurrect the A4 zombie).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '../db/client';
import { connections, chatSessions } from '../db/schema';
import { createSession, setDiscardTombstone, wasTurnDiscarded, clearDiscardTombstone } from './session-service';

let connId: string;
let sessionId: string;

beforeAll(async () => {
  const [c] = await db.insert(connections).values({
    name: 'tombstone-test', kind: 'sqlite-file', dialect: 'sqlite', config: { path: '/tmp/x.db' },
    secretEncrypted: null, isReadOnlyVerified: true,
  }).returning({ id: connections.id });
  connId = c.id;
  const s = await createSession(connId);
  sessionId = s.id;
});

afterAll(async () => {
  await db.delete(connections).where(eq(connections.id, connId));
});

describe('discard tombstone', () => {
  it('blocks a turn that started before the discard; spares one started after', async () => {
    const turnBefore = new Date(Date.now() - 60_000).toISOString();
    await setDiscardTombstone(sessionId, new Date().toISOString());
    expect(await wasTurnDiscarded(sessionId, turnBefore)).toBe(true);
    const turnAfter = new Date(Date.now() + 60_000).toISOString();
    expect(await wasTurnDiscarded(sessionId, turnAfter)).toBe(false);
  });

  it('consume-on-skip clears the key; a later check is clean', async () => {
    await clearDiscardTombstone(sessionId);
    const [row] = await db.select({ m: chatSessions.metadata }).from(chatSessions).where(eq(chatSessions.id, sessionId));
    expect((row?.m as Record<string, unknown> | null)?.discardAfter).toBeUndefined();
    expect(await wasTurnDiscarded(sessionId, new Date(0).toISOString())).toBe(false);
  });

  it('clear on a session with no tombstone is a no-op (metadata preserved)', async () => {
    await db.update(chatSessions).set({ metadata: { keepMe: 1 } }).where(eq(chatSessions.id, sessionId));
    await clearDiscardTombstone(sessionId);
    const [row] = await db.select({ m: chatSessions.metadata }).from(chatSessions).where(eq(chatSessions.id, sessionId));
    expect((row?.m as Record<string, unknown>).keepMe).toBe(1);
  });
});
