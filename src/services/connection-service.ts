/**
 * Connection CRUD + provider assembly. Encrypts secrets on write, builds a
 * ConnectionProvider on demand, and runs the write-privilege probe (RT-F2).
 */
import { eq } from 'drizzle-orm';
import { db } from '../db/client';
import { connections } from '../db/schema';
import { encryptSecret } from './crypto/credential-cipher';
import { buildProvider, type ConnectionRow } from './connection-providers/provider-factory';
import type { ConnectionProvider } from './connection-providers/provider-interface';

export interface CreateConnectionInput {
  name: string;
  kind: 'tcp-driver' | 'sqlite-file' | 'remote-http';
  dialect: 'postgres' | 'mysql' | 'sqlite';
  config: Record<string, unknown>;
  /** Plaintext secret (password/token); encrypted before storage. */
  secret?: string;
}

/** Connect + probe write privilege WITHOUT saving — powers the "Test connection"
 *  button and the create/update flows. Returns whether it connected and whether the
 *  DB user is read-only (RT-F2). */
export async function testConnectionConfig(input: { kind: CreateConnectionInput['kind']; dialect: CreateConnectionInput['dialect']; config: Record<string, unknown>; secret?: string }): Promise<{ ok: boolean; isReadOnly: boolean; detail: string }> {
  const secretEncrypted = input.secret ? encryptSecret(input.secret) : null;
  const provider = buildProvider({ kind: input.kind, dialect: input.dialect, config: input.config, secretEncrypted });
  try {
    await provider.testConnection();
    const probe = await provider.probeWritePrivilege();
    return { ok: true, isReadOnly: probe.isReadOnly, detail: probe.detail };
  } catch (e) {
    return { ok: false, isReadOnly: false, detail: e instanceof Error ? e.message : String(e) };
  } finally {
    await provider.close();
  }
}

export async function createConnection(input: CreateConnectionInput) {
  const secretEncrypted = input.secret ? encryptSecret(input.secret) : null;

  // Probe read-only before saving so we can persist the verified flag (RT-F2).
  const probe = await testConnectionConfig(input);
  if (!probe.ok) throw new Error(probe.detail);

  const [row] = await db
    .insert(connections)
    .values({
      name: input.name,
      kind: input.kind,
      dialect: input.dialect,
      config: input.config,
      secretEncrypted,
      isReadOnlyVerified: probe.isReadOnly,
    })
    .returning();
  return row;
}

/** Update a connection's config/secret in place (edit instead of delete+recreate).
 *  Re-probes read-only. A blank secret keeps the existing one. */
export async function updateConnection(id: string, input: { name?: string; config?: Record<string, unknown>; dialect?: CreateConnectionInput['dialect']; secret?: string }) {
  const existing = await getConnection(id);
  if (!existing) throw new Error('Connection not found');

  const secretEncrypted = input.secret ? encryptSecret(input.secret) : existing.secretEncrypted;
  const config = input.config ?? (existing.config as Record<string, unknown>);
  const dialect = input.dialect ?? (existing.dialect as CreateConnectionInput['dialect']);

  // Re-probe with the new settings.
  const provider = buildProvider({ kind: existing.kind, dialect, config, secretEncrypted });
  let isReadOnlyVerified = false;
  try {
    await provider.testConnection();
    isReadOnlyVerified = (await provider.probeWritePrivilege()).isReadOnly;
  } finally {
    await provider.close();
  }

  const [row] = await db.update(connections)
    .set({ name: input.name ?? existing.name, config, dialect, secretEncrypted, isReadOnlyVerified })
    .where(eq(connections.id, id))
    .returning();
  return row;
}

export async function listConnections() {
  return db.select().from(connections);
}

export async function getConnection(id: string) {
  const [row] = await db.select().from(connections).where(eq(connections.id, id));
  return row ?? null;
}

export async function deleteConnection(id: string) {
  await db.delete(connections).where(eq(connections.id, id));
}

/** Build a live provider for a stored connection. Caller must close() it. */
export async function getProvider(id: string): Promise<ConnectionProvider> {
  const row = await getConnection(id);
  if (!row) throw new Error(`Connection not found: ${id}`);
  return buildProvider(row as unknown as ConnectionRow);
}
