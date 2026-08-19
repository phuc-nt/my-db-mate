/**
 * Governed schema scope: the datamart boundary.
 *
 * A connection may declare a scope — a set of datasets and/or tables the agent
 * is allowed to see and query. This is enforcement, not prompting: the schema
 * summary is filtered so the agent rarely tries anything out of scope, and
 * `executeQuery` blocks the SQL outright when it does. Null scope means unscoped
 * (the full synced schema), which is the pre-existing behavior and the default.
 *
 * Fail-closed: when a statement's table references cannot be determined at all
 * (unparseable SQL), a scoped connection blocks it. Only a statement that
 * provably reads no base table (`SELECT 1`) passes without a matching entry.
 */
import { eq } from 'drizzle-orm';
import { db } from '../db/client';
import { rm } from 'node:fs/promises';
import { connections, schemaTables, accelerateSnapshots } from '../db/schema';
import { extractScopeRefs, type ScopeRef } from '../lib/sql-scope-refs';
import { cachePaths } from './accelerator/snapshot-cache-service';
import type { Dialect } from './connection-providers/provider-interface';

export interface SchemaScope {
  /** Dataset/schema names allowed in full. */
  datasets?: string[];
  /** Individual tables allowed, canonical `dataset.table` or bare `table`. */
  tables?: string[];
  /** Phase 2: restrict the connection to governed virtual views only. */
  viewsOnly?: boolean;
}

/** A scope with no datasets and no tables grants nothing and would block every
 *  query — treat it as absent so a half-filled UI state can't lock a user out. */
export function isScopeActive(scope: SchemaScope | null | undefined): scope is SchemaScope {
  if (!scope) return false;
  return (scope.datasets?.length ?? 0) > 0 || (scope.tables?.length ?? 0) > 0;
}

export async function getScope(connectionId: string): Promise<SchemaScope | null> {
  const [row] = await db
    .select({ schemaScope: connections.schemaScope })
    .from(connections)
    .where(eq(connections.id, connectionId));
  return (row?.schemaScope as SchemaScope | null) ?? null;
}

/**
 * Apply a scope. Beyond writing the column this evicts cached copies of data the
 * new boundary withholds: an accelerator snapshot is a local Parquet extract of
 * a real table, so leaving one in place would keep answering questions about a
 * table the connection just stopped granting. Returns what was evicted so the
 * caller can report it.
 */
export async function setScope(connectionId: string, scope: SchemaScope | null): Promise<{ evictedSnapshots: number }> {
  await db.update(connections).set({ schemaScope: scope }).where(eq(connections.id, connectionId));
  if (!isScopeActive(scope)) return { evictedSnapshots: 0 };

  const snapshots = await db
    .select({ id: accelerateSnapshots.id, cacheKey: accelerateSnapshots.cacheKey, sql: accelerateSnapshots.sql })
    .from(accelerateSnapshots)
    .where(eq(accelerateSnapshots.connectionId, connectionId));

  let evicted = 0;
  for (const snap of snapshots) {
    // Extracts are `SELECT * FROM <table>`; an unparseable one is evicted too,
    // since a snapshot whose source cannot be verified cannot be shown to be
    // inside the boundary.
    // The extract shape is dialect-neutral, so any parser dialect reads it the
    // same way; accelerator snapshots never exist for BigQuery connections.
    const refs = extractScopeRefs(snap.sql, 'postgres');
    const outOfScope = refs === null || refs.some((r) => !isRefInScope(scope, r));
    if (!outOfScope) continue;
    await db.delete(accelerateSnapshots).where(eq(accelerateSnapshots.id, snap.id));
    const { dir } = cachePaths(connectionId, snap.cacheKey);
    await rm(dir, { recursive: true, force: true });
    evicted++;
  }
  return { evictedSnapshots: evicted };
}

const lower = (s: string | null | undefined) => (s ?? '').toLowerCase();

/** Wildcard table refs (`ds.events_*`) name a shard family, not one table. A
 *  bare `*` is rejected: as a scope entry it would silently grant everything,
 *  which is the opposite of what listing specific tables is meant to express. */
function matchesWildcard(pattern: string, candidate: string): boolean {
  if (!pattern.endsWith('*') || pattern.length < 2) return false;
  return candidate.startsWith(pattern.slice(0, -1));
}

/**
 * Whether one table reference is inside the scope. A reference is admitted when
 * its dataset is allowed in full, or when the table itself is listed.
 *
 * BigQuery notes:
 * - `INFORMATION_SCHEMA` views carry metadata, not rows, so they ride on their
 *   owning dataset's admission — the agent needs them to orient itself.
 * - A wildcard ref is admitted only via its dataset, or when a listed table
 *   entry is itself the same wildcard family.
 */
export function isRefInScope(scope: SchemaScope, ref: ScopeRef): boolean {
  const datasets = (scope.datasets ?? []).map(lower);
  const tables = (scope.tables ?? []).map(lower);
  const refSchema = lower(ref.schemaName);
  const refTable = lower(ref.tableName);

  if (refSchema && datasets.includes(refSchema)) return true;

  // Qualified `dataset.table`, plus the bare name for dialects that leave the
  // schema implicit (the scope UI stores whichever form the sync produced).
  const qualified = refSchema ? `${refSchema}.${refTable}` : refTable;
  if (tables.includes(qualified) || tables.includes(refTable)) return true;

  // A listed wildcard family covers the concrete shards under it. The reverse —
  // letting a WILDCARD REFERENCE cover a listed table — is deliberately absent:
  // it inverts the allowlist, since `ds.*` "covers" every entry and would turn a
  // single-table grant into a read of the whole dataset. A wildcard reference is
  // admitted only by its dataset, or by a listed entry naming that exact family.
  for (const t of tables) {
    if (matchesWildcard(t, qualified) || matchesWildcard(t, refTable)) return true;
  }
  return false;
}

/** Filter synced tables down to the scope. Unscoped connections pass through. */
export function filterTablesToScope<T extends { schemaName?: string | null; tableName: string }>(
  scope: SchemaScope | null | undefined,
  tables: T[],
): T[] {
  if (!isScopeActive(scope)) return tables;
  return tables.filter((t) => isRefInScope(scope, { schemaName: t.schemaName ?? null, tableName: t.tableName }));
}

export type ScopeVerdict = { status: 'ok' } | { status: 'blocked'; reason: string };

/** Identifiers are echoed back to the agent in the block message; strip anything
 *  that isn't part of a name so a crafted table name can't inject instructions. */
function sanitizeIdentifier(s: string): string {
  return s.replace(/[^A-Za-z0-9_.*-]/g, '');
}

type SyncedTable = { schemaName: string | null; tableName: string };

/** The in-scope table list shown to the agent when it strays, so it can retry
 *  without a round trip. Capped — a mart can still hold dozens of tables. */
function describeScope(rows: SyncedTable[], scope: SchemaScope): string {
  const inScope = filterTablesToScope(scope, rows).map((t) =>
    sanitizeIdentifier(t.schemaName ? `${t.schemaName}.${t.tableName}` : t.tableName),
  );
  const names = inScope.length > 0 ? inScope : (scope.datasets ?? []).map((d) => `${sanitizeIdentifier(d)}.*`);
  const shown = names.slice(0, 40).join(', ');
  return names.length > 40 ? `${shown}, … (+${names.length - 40} more)` : shown;
}

/** Does this reference name a table the sync actually found? Compared on the
 *  bare name as well as the qualified one, since dialects differ on whether a
 *  query spells the schema out and the sync stores whichever form it saw. */
function resolvesToSyncedTable(rows: SyncedTable[], ref: ScopeRef): boolean {
  const refTable = ref.tableName.toLowerCase();
  const refSchema = lower(ref.schemaName);
  // A wildcard family resolves if any synced shard falls under it.
  if (refTable.endsWith('*') && refTable.length > 1) {
    const prefix = refTable.slice(0, -1);
    return rows.some((r) => r.tableName.toLowerCase().startsWith(prefix)
      && (!refSchema || lower(r.schemaName) === refSchema));
  }
  // INFORMATION_SCHEMA is a per-dataset pseudo-view, never a synced row; it
  // carries metadata only and rides on its dataset's admission.
  if (refTable.startsWith('information_schema.')) return true;
  return rows.some((r) => {
    if (r.tableName.toLowerCase() !== refTable) return false;
    return !refSchema || !r.schemaName || lower(r.schemaName) === refSchema;
  });
}

/**
 * The scope guard. Called for every statement on a scoped connection, after the
 * safety verdict (so it inspects the SQL that will actually run) and before any
 * execution path — including acceleration and BigQuery snapshots, so no cached
 * copy of out-of-scope data can be created either.
 *
 * Two conditions must both hold for a reference to pass: it must resolve to a
 * table the sync actually found, and that table must be inside the scope. The
 * first is what keeps the guard honest. Parse-failure fail-closed only covers
 * SQL that does not parse; it does nothing for SQL that parses into the WRONG
 * reference, and the parser's output is lossy in ways that have produced exactly
 * that (a quoted name containing a dot; Postgres `FROM ONLY t` reading the table
 * as an alias). Requiring resolution turns every such normalization gap into a
 * block instead of a bypass, and costs nothing real: a legitimate query names
 * tables the sync has seen.
 */
export async function assertSqlInScope(params: {
  connectionId: string;
  sql: string;
  dialect: Dialect;
  scope?: SchemaScope | null;
}): Promise<ScopeVerdict> {
  const scope = params.scope !== undefined ? params.scope : await getScope(params.connectionId);
  if (!isScopeActive(scope)) return { status: 'ok' };

  const refs = extractScopeRefs(params.sql, params.dialect);
  if (refs === null) {
    // Cannot prove what this reads → cannot prove it is in scope.
    return {
      status: 'blocked',
      reason: 'SQL could not be parsed to verify it stays within the governed scope',
    };
  }
  // Reads no base table at all — trivially inside any boundary.
  if (refs.length === 0) return { status: 'ok' };

  // Read once, used twice (resolution + the block message). Deliberately not
  // cached: measured at ~2.5ms against a 5000-table schema, which is noise next
  // to the query being guarded, and a cache would have to be invalidated on
  // every re-sync — a stale one would block newly-synced tables.
  const synced: SyncedTable[] = await db
    .select({ schemaName: schemaTables.schemaName, tableName: schemaTables.tableName })
    .from(schemaTables)
    .where(eq(schemaTables.connectionId, params.connectionId));

  const unresolved = refs.filter((r) => !resolvesToSyncedTable(synced, r));
  if (unresolved.length > 0) {
    const names = unresolved.map((r) => sanitizeIdentifier(r.tableName)).join(', ');
    return {
      status: 'blocked',
      reason: `${names} does not match any table in this connection's synced schema, so it cannot be verified against the governed scope. Re-sync the connection if the table is new.`,
    };
  }

  const offending = refs.filter((r) => !isRefInScope(scope, r));
  if (offending.length === 0) return { status: 'ok' };

  const names = offending
    .map((r) => sanitizeIdentifier(r.schemaName ? `${r.schemaName}.${r.tableName}` : r.tableName))
    .join(', ');
  const allowed = describeScope(synced, scope);
  return {
    status: 'blocked',
    reason: `${names} is outside the governed scope for this connection. In-scope tables: ${allowed || '(none)'}`,
  };
}
