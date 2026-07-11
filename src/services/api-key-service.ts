/**
 * API keys for the MCP server (RT-F4). Tokens are shown once at creation and
 * stored only as a sha256 hash. Each key is scoped to a connection and a max
 * risk tier it may auto-run. No plaintext token is ever persisted.
 */
import { createHash, randomBytes } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import { db } from '../db/client';
import { apiKeys } from '../db/ecosystem-schema';

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Create a key; returns the RAW token exactly once (never retrievable again). */
export async function createApiKey(input: { name: string; connectionId: string; maxTier?: 'low' | 'medium' }) {
  const token = `mdm_${randomBytes(24).toString('hex')}`;
  const [row] = await db.insert(apiKeys).values({
    name: input.name, keyHash: hashToken(token), connectionId: input.connectionId, maxTier: input.maxTier ?? 'low',
  }).returning();
  return { id: row.id, token, name: row.name };
}

/** Resolve a raw token to its (non-revoked) key row, or null. Updates lastUsedAt. */
export async function resolveApiKey(token: string) {
  const [row] = await db.select().from(apiKeys)
    .where(and(eq(apiKeys.keyHash, hashToken(token)), isNull(apiKeys.revokedAt)));
  if (!row) return null;
  await db.update(apiKeys).set({ lastUsedAt: new Date() }).where(eq(apiKeys.id, row.id));
  return row;
}

export async function listApiKeys() {
  // Never returns keyHash.
  return db.select({ id: apiKeys.id, name: apiKeys.name, connectionId: apiKeys.connectionId, maxTier: apiKeys.maxTier, lastUsedAt: apiKeys.lastUsedAt, revokedAt: apiKeys.revokedAt, createdAt: apiKeys.createdAt }).from(apiKeys);
}

export async function revokeApiKey(id: string) {
  await db.update(apiKeys).set({ revokedAt: new Date() }).where(eq(apiKeys.id, id));
}
