/**
 * Connection CRUD + provider assembly. Encrypts secrets on write, builds a
 * ConnectionProvider on demand, and runs the write-privilege probe (RT-F2).
 */
import { eq } from 'drizzle-orm';
import { db } from '../db/client';
import { connections } from '../db/schema';
import { encryptSecret } from './crypto/credential-cipher';
import { buildProvider, type ConnectionRow } from './connection-providers/provider-factory';
import { closeTunnel } from './connection-providers/ssh-tunnel-manager';
import { sanitizeBigQueryConnError } from './connection-providers/bigquery-provider';
import type { ConnectionProvider } from './connection-providers/provider-interface';

export interface CreateConnectionInput {
  name: string;
  kind: 'tcp-driver' | 'sqlite-file' | 'remote-http' | 'mssql-driver' | 'bigquery-driver';
  dialect: 'postgres' | 'mysql' | 'sqlite' | 'mssql' | 'bigquery';
  config: Record<string, unknown>;
  /** Plaintext secret (password/token); encrypted before storage. */
  secret?: string;
  /** Plaintext SSH private key or password when connecting via a bastion. */
  sshSecret?: string;
  /** Plaintext BigQuery service-account JSON (stringified); encrypted before storage. */
  bigqueryServiceAccountJson?: string;
  /** Hard cap for BigQuery's `maximumBytesBilled`. Falls back to the schema default (1 GiB) when unset. */
  bigqueryMaxBytesPerQuery?: number;
  /** Per-connection daily byte budget for BigQuery background analytics. Falls back to the schema default (10 GiB/day) when unset. */
  bigqueryDailyBytesBudget?: number;
  /** BigQuery offline mode: background analytics serve from a DuckDB-over-BigQuery snapshot instead of live queries. Off by default. */
  bigqueryOfflineMode?: boolean;
  /** DuckDB accelerator opt-in (Phase 2). Off by default. */
  accelerateEnabled?: boolean;
  accelerateTtlMs?: number | null;
}

/** ssh2 auth errors can carry key paths / material — surface a generic message to
 *  the client and keep the raw error server-side only. */
function sanitizeConnError(e: unknown, usesSsh: boolean): string {
  const msg = e instanceof Error ? e.message : String(e);
  if (usesSsh && /(authentication|handshake|privateKey|key|ssh|ECONN|timed out)/i.test(msg)) {
    console.error('[connection] SSH tunnel error:', msg);
    return 'SSH tunnel failed: check the bastion host, port, user, and key/password.';
  }
  return msg;
}

/** Connect + probe write privilege WITHOUT saving — powers the "Test connection"
 *  button and the create/update flows. Returns whether it connected and whether the
 *  DB user is read-only (RT-F2). */
export async function testConnectionConfig(input: { kind: CreateConnectionInput['kind']; dialect: CreateConnectionInput['dialect']; config: Record<string, unknown>; secret?: string; sshSecret?: string; bigqueryServiceAccountJson?: string; bigqueryMaxBytesPerQuery?: number }): Promise<{ ok: boolean; isReadOnly: boolean; detail: string }> {
  const secretEncrypted = input.secret ? encryptSecret(input.secret) : null;
  const sshSecretEncrypted = input.sshSecret ? encryptSecret(input.sshSecret) : null;
  const bigqueryServiceAccountJsonEncrypted = input.bigqueryServiceAccountJson ? encryptSecret(input.bigqueryServiceAccountJson) : null;
  const provider = buildProvider({
    kind: input.kind,
    dialect: input.dialect,
    config: input.config,
    secretEncrypted,
    sshSecretEncrypted,
    bigqueryServiceAccountJsonEncrypted,
    bigqueryMaxBytesPerQuery: input.bigqueryMaxBytesPerQuery ?? 1_073_741_824,
  });
  const usesSsh = Boolean(input.config.sshHost);
  const isBigQuery = input.kind === 'bigquery-driver';
  try {
    await provider.testConnection();
    const probe = await provider.probeWritePrivilege();
    return { ok: true, isReadOnly: probe.isReadOnly, detail: probe.detail };
  } catch (e) {
    const detail = isBigQuery ? sanitizeBigQueryConnError(e) : sanitizeConnError(e, usesSsh);
    return { ok: false, isReadOnly: false, detail };
  } finally {
    await provider.close();
    // A test-connection tunnel is keyed by an ephemeral id — tear it down so it
    // doesn't linger (real connections tear down on delete/update instead).
    if (usesSsh) await closeTunnel(`test-${String(input.config.sshHost)}-${String(input.config.host)}`).catch(() => {});
  }
}

export async function createConnection(input: CreateConnectionInput) {
  const secretEncrypted = input.secret ? encryptSecret(input.secret) : null;
  const sshSecretEncrypted = input.sshSecret ? encryptSecret(input.sshSecret) : null;
  const bigqueryServiceAccountJsonEncrypted = input.bigqueryServiceAccountJson ? encryptSecret(input.bigqueryServiceAccountJson) : null;

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
      sshSecretEncrypted,
      isReadOnlyVerified: probe.isReadOnly,
      accelerateEnabled: input.accelerateEnabled ?? false,
      accelerateTtlMs: input.accelerateTtlMs ?? null,
      bigqueryServiceAccountJsonEncrypted,
      ...(input.bigqueryMaxBytesPerQuery ? { bigqueryMaxBytesPerQuery: input.bigqueryMaxBytesPerQuery } : {}),
      // `!= null` (not truthy) so an explicit 0 — "block all background BigQuery" — is
      // honored fail-closed rather than dropped back to the schema default.
      ...(input.bigqueryDailyBytesBudget != null ? { bigqueryDailyBytesBudget: input.bigqueryDailyBytesBudget } : {}),
      ...(input.bigqueryOfflineMode != null ? { bigqueryOfflineMode: input.bigqueryOfflineMode } : {}),
    })
    .returning();
  return row;
}

/** Update a connection's config/secret in place (edit instead of delete+recreate).
 *  Re-probes read-only. A blank secret keeps the existing one. */
export async function updateConnection(id: string, input: { name?: string; config?: Record<string, unknown>; dialect?: CreateConnectionInput['dialect']; secret?: string; sshSecret?: string; bigqueryServiceAccountJson?: string; bigqueryMaxBytesPerQuery?: number; bigqueryDailyBytesBudget?: number; bigqueryOfflineMode?: boolean; accelerateEnabled?: boolean; accelerateTtlMs?: number | null }) {
  const existing = await getConnection(id);
  if (!existing) throw new Error('Connection not found');

  const secretEncrypted = input.secret ? encryptSecret(input.secret) : existing.secretEncrypted;
  const sshSecretEncrypted = input.sshSecret ? encryptSecret(input.sshSecret) : existing.sshSecretEncrypted;
  const bigqueryServiceAccountJsonEncrypted = input.bigqueryServiceAccountJson
    ? encryptSecret(input.bigqueryServiceAccountJson)
    : existing.bigqueryServiceAccountJsonEncrypted;
  const bigqueryMaxBytesPerQuery = input.bigqueryMaxBytesPerQuery ?? existing.bigqueryMaxBytesPerQuery;
  const bigqueryDailyBytesBudget = input.bigqueryDailyBytesBudget ?? existing.bigqueryDailyBytesBudget;
  const bigqueryOfflineMode = input.bigqueryOfflineMode ?? existing.bigqueryOfflineMode;
  const config = input.config ?? (existing.config as Record<string, unknown>);
  const dialect = input.dialect ?? (existing.dialect as CreateConnectionInput['dialect']);

  // Host/tunnel settings may have changed — drop any existing tunnel so the
  // re-probe (and future queries) build a fresh one against the new target.
  await closeTunnel(id).catch(() => {});

  // Re-probe with the new settings.
  const provider = buildProvider({
    id,
    kind: existing.kind,
    dialect,
    config,
    secretEncrypted,
    sshSecretEncrypted,
    bigqueryServiceAccountJsonEncrypted,
    bigqueryMaxBytesPerQuery,
  });
  let isReadOnlyVerified = false;
  try {
    await provider.testConnection();
    isReadOnlyVerified = (await provider.probeWritePrivilege()).isReadOnly;
  } catch (e) {
    throw new Error(existing.kind === 'bigquery-driver' ? sanitizeBigQueryConnError(e) : (e instanceof Error ? e.message : String(e)));
  } finally {
    await provider.close();
  }

  const [row] = await db.update(connections)
    .set({
      name: input.name ?? existing.name,
      config,
      dialect,
      secretEncrypted,
      sshSecretEncrypted,
      isReadOnlyVerified,
      accelerateEnabled: input.accelerateEnabled ?? existing.accelerateEnabled,
      accelerateTtlMs: input.accelerateTtlMs !== undefined ? input.accelerateTtlMs : existing.accelerateTtlMs,
      bigqueryServiceAccountJsonEncrypted,
      bigqueryMaxBytesPerQuery,
      bigqueryDailyBytesBudget,
      bigqueryOfflineMode,
    })
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
  await closeTunnel(id).catch(() => {});
  await db.delete(connections).where(eq(connections.id, id));
}

/** Build a live provider for a stored connection. Caller must close() it. */
export async function getProvider(id: string): Promise<ConnectionProvider> {
  const row = await getConnection(id);
  if (!row) throw new Error(`Connection not found: ${id}`);
  return buildProvider(row as unknown as ConnectionRow);
}
