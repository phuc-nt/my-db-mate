/**
 * Curated views: a datamart defined in my-db-mate instead of in the warehouse.
 *
 * The product's answer to "we have no datamart yet". A view pairs a business
 * name with a curated SELECT, and at query time the definition is inlined as a
 * CTE — so a governed layer exists without needing write access to the target
 * database, and the read-only core stays exactly as strict as it was.
 *
 * Everything expensive is done at SAVE time rather than query time: the SQL is
 * validated against the safety layer and the governed scope, and the column list
 * is probed once and cached. A saved view is therefore known-good, and building
 * a prompt costs one row read instead of a round trip to the warehouse.
 */
import { and, eq } from 'drizzle-orm';
import { db } from '../db/client';
import { virtualViews } from '../db/context-schema';
import { schemaTables } from '../db/schema';
import { getConnection, getProvider } from './connection-service';
import { validateSql } from './safety/safety-service';
import { assertSqlInScope } from './schema-scope-service';
import { directBaseTables, expandVirtualViews, mentionsIdentifier, type VirtualViewDef } from '../lib/sql-view-expand';
import { BigQueryConnectionProvider } from './connection-providers/bigquery-provider';
import type { Dialect } from './connection-providers/provider-interface';

export interface ViewColumn { name: string; type: string }

export interface VirtualViewRow {
  id: string;
  name: string;
  description: string | null;
  sql: string;
  columnsCache: ViewColumn[] | null;
  isDisabled: boolean;
}

export class VirtualViewError extends Error {}

/** Business names only: lowercase snake_case. Keeps the identifier safe to
 *  inline unquoted-adjacent, and keeps the agent-facing namespace predictable. */
const NAME_RE = /^[a-z][a-z0-9_]{0,62}$/;

/**
 * mssql is excluded in v1, and not for a stylistic reason: `capRows` cannot
 * append OFFSET/FETCH to a WITH query that has no ORDER BY, so it returns the
 * statement uncapped. Expansion turns EVERY view query into a WITH query, which
 * would quietly remove the row cap from the connection. Refusing to save is the
 * honest option; changing capRows' semantics for all mssql queries is not a
 * trade this feature gets to make on its own.
 */
function assertDialectSupported(dialect: Dialect) {
  if (dialect === 'mssql') {
    throw new VirtualViewError(
      'Curated views are not available on SQL Server yet: inlining a view turns the query into a CTE, which would bypass the row cap.',
    );
  }
}

export async function listViews(connectionId: string): Promise<VirtualViewRow[]> {
  const rows = await db.select().from(virtualViews).where(eq(virtualViews.connectionId, connectionId));
  return rows.map((r) => ({
    id: r.id, name: r.name, description: r.description, sql: r.sql,
    columnsCache: (r.columnsCache as ViewColumn[] | null) ?? null, isDisabled: r.isDisabled,
  }));
}

/** Enabled views only, in the shape the rewriter wants. Used on the hot path. */
export async function listActiveViewDefs(connectionId: string): Promise<VirtualViewDef[]> {
  const rows = await db
    .select({ name: virtualViews.name, sql: virtualViews.sql })
    .from(virtualViews)
    .where(and(eq(virtualViews.connectionId, connectionId), eq(virtualViews.isDisabled, false)));
  return rows;
}

/**
 * Probe the column list for a saved definition.
 *
 * On BigQuery this MUST be a dry run: `LIMIT 0` still bills the full scan there
 * (BigQuery charges for bytes processed, not rows returned), so probing a view
 * over a large table would cost real money every time someone saved an edit. A
 * dry run is free and reports the result schema anyway. Everywhere else
 * `LIMIT 0` is genuinely cheap and gives the same answer.
 */
async function probeColumns(connectionId: string, sql: string): Promise<ViewColumn[]> {
  const provider = await getProvider(connectionId);
  try {
    if (provider instanceof BigQueryConnectionProvider) {
      const schema = await provider.dryRunSchema(sql);
      return schema.map((c) => ({ name: c.name, type: c.type }));
    }
    const res = await provider.executeReadOnly(`SELECT * FROM (\n${sql}\n) AS _probe LIMIT 0`);
    return res.columns.map((name) => ({ name, type: 'unknown' }));
  } finally {
    await provider.close();
  }
}

/**
 * Validate a definition the way the guards will see it at run time.
 *
 * A view is stored SQL that later executes on someone else's behalf, so it gets
 * the same treatment as SQL typed by hand — plus two rules of its own: it may
 * not build on another view (v1 keeps the dependency graph empty rather than
 * having to detect cycles), and its name may not collide with a real table on
 * ANY schema. The collision check is deliberately across all schemas: two
 * BigQuery datasets can each hold an `orders`, and a bare reference to a view
 * of that name would shadow whichever one the reader had in mind.
 */
async function validateDefinition(params: {
  connectionId: string; name: string; sql: string; dialect: Dialect; excludeId?: string;
}): Promise<void> {
  const { connectionId, name, sql, dialect, excludeId } = params;

  if (!NAME_RE.test(name)) {
    throw new VirtualViewError('View name must be lowercase snake_case, starting with a letter (e.g. doanh_thu_thang).');
  }

  const safety = validateSql(sql, dialect);
  if (safety.status === 'blocked') {
    throw new VirtualViewError(`View SQL rejected by the safety layer: ${safety.reason}`);
  }

  // The governed boundary applies to stored SQL too — otherwise a view would be
  // a way to park a forbidden table now and read it later.
  const scope = await assertSqlInScope({ connectionId, sql: safety.sql, dialect });
  if (scope.status === 'blocked') {
    throw new VirtualViewError(`View SQL is outside the governed scope: ${scope.reason}`);
  }

  const siblings = (await listViews(connectionId)).filter((v) => v.id !== excludeId);
  if (siblings.some((v) => v.name === name)) {
    throw new VirtualViewError(`A view named "${name}" already exists on this connection.`);
  }
  const referenced = siblings.find((v) => mentionsIdentifier(sql, v.name));
  if (referenced) {
    throw new VirtualViewError(
      `A view cannot build on another view (this one references "${referenced.name}"). Inline the definition instead.`,
    );
  }

  const realTables = await db
    .select({ tableName: schemaTables.tableName, schemaName: schemaTables.schemaName })
    .from(schemaTables)
    .where(eq(schemaTables.connectionId, connectionId));
  const clash = realTables.find((t) => t.tableName.toLowerCase() === name);
  if (clash) {
    const where = clash.schemaName ? `${clash.schemaName}.${clash.tableName}` : clash.tableName;
    throw new VirtualViewError(`"${name}" is already the name of a real table (${where}). Pick a distinct business name.`);
  }
}

export async function createView(params: {
  connectionId: string; name: string; sql: string; description?: string;
}): Promise<VirtualViewRow> {
  const conn = await getConnection(params.connectionId);
  if (!conn) throw new VirtualViewError('Connection not found');
  const dialect = conn.dialect as Dialect;
  assertDialectSupported(dialect);

  const name = params.name.trim().toLowerCase();
  const sql = params.sql.trim();
  await validateDefinition({ connectionId: params.connectionId, name, sql, dialect });
  const columns = await probeColumns(params.connectionId, sql);

  const [row] = await db.insert(virtualViews).values({
    connectionId: params.connectionId, name, sql,
    description: params.description?.trim() || null, columnsCache: columns,
  }).returning();
  // Invalidated here rather than in the callers: a route that forgets would
  // serve a stale definition, which is precisely the failure this layer exists
  // to prevent — the number would no longer match the agreed meaning.
  invalidateViewCache(params.connectionId);
  return {
    id: row.id, name: row.name, description: row.description, sql: row.sql,
    columnsCache: columns, isDisabled: row.isDisabled,
  };
}

export async function updateView(params: {
  connectionId: string; id: string; name?: string; sql?: string; description?: string; isDisabled?: boolean;
}): Promise<VirtualViewRow> {
  const conn = await getConnection(params.connectionId);
  if (!conn) throw new VirtualViewError('Connection not found');
  const dialect = conn.dialect as Dialect;
  assertDialectSupported(dialect);

  const [existing] = await db.select().from(virtualViews)
    .where(and(eq(virtualViews.id, params.id), eq(virtualViews.connectionId, params.connectionId)));
  if (!existing) throw new VirtualViewError('View not found');

  const name = (params.name ?? existing.name).trim().toLowerCase();
  const sql = (params.sql ?? existing.sql).trim();
  const definitionChanged = sql !== existing.sql || name !== existing.name;

  let columns = (existing.columnsCache as ViewColumn[] | null) ?? null;
  if (definitionChanged) {
    await validateDefinition({ connectionId: params.connectionId, name, sql, dialect, excludeId: params.id });
    if (sql !== existing.sql) columns = await probeColumns(params.connectionId, sql);
  }

  const [row] = await db.update(virtualViews).set({
    name, sql, columnsCache: columns,
    description: params.description !== undefined ? (params.description.trim() || null) : existing.description,
    isDisabled: params.isDisabled ?? existing.isDisabled,
    updatedAt: new Date(),
  }).where(eq(virtualViews.id, params.id)).returning();
  invalidateViewCache(params.connectionId);

  return {
    id: row.id, name: row.name, description: row.description, sql: row.sql,
    columnsCache: columns, isDisabled: row.isDisabled,
  };
}

export async function deleteView(connectionId: string, id: string): Promise<void> {
  await db.delete(virtualViews)
    .where(and(eq(virtualViews.id, id), eq(virtualViews.connectionId, connectionId)));
  invalidateViewCache(connectionId);
}

/**
 * Inline any governed views a statement references.
 *
 * Called from the executor before every other guard. A connection with no views
 * must pay nothing for this feature, so the view list is read once and cached
 * in-process (the app is single-process; CRUD invalidates the entry).
 */
/**
 * Run a candidate definition and return a few rows, for the author's screen.
 *
 * Judged exactly as `createView` judges it — safety layer, then the table-level
 * governed scope — and deliberately NOT as `viewsOnly`. Authoring a view is the
 * one act that must read raw tables: a definition is precisely the thing that
 * turns a raw table into a governed one. Enforcing `viewsOnly` here would mean
 * that switching it on froze the view set forever, since no new definition could
 * ever be previewed. The boundary that matters is still enforced: SQL the table
 * scope forbids is refused here, and a saved view is re-checked at every read.
 */
export async function previewDefinition(params: {
  connectionId: string; sql: string; limit?: number;
}): Promise<{ columns: string[]; rows: unknown[][] }> {
  const conn = await getConnection(params.connectionId);
  if (!conn) throw new VirtualViewError('Connection not found');
  const dialect = conn.dialect as Dialect;
  assertDialectSupported(dialect);

  const sql = params.sql.trim();
  if (!sql) throw new VirtualViewError('No SQL provided');

  const verdict = validateSql(sql, dialect);
  if (verdict.status === 'blocked') {
    throw new VirtualViewError(`Rejected by the safety layer: ${verdict.reason}`);
  }
  const scoped = await assertSqlInScope({ connectionId: params.connectionId, sql: verdict.sql, dialect });
  if (scoped.status === 'blocked') {
    throw new VirtualViewError(`Outside the governed scope: ${scoped.reason}`);
  }

  const limit = params.limit ?? 10;
  const provider = await getProvider(params.connectionId);
  try {
    const res = await provider.executeReadOnly(`SELECT * FROM (\n${verdict.sql}\n) AS _preview LIMIT ${limit}`);
    return { columns: res.columns, rows: res.rows };
  } finally {
    await provider.close();
  }
}

export async function expandForConnection(
  connectionId: string, sql: string, dialect: Dialect, viewsOnly: boolean,
) {
  const views = await getCachedViews(connectionId);

  // `viewsOnly` means the curated layer IS the interface: the agent may compose
  // freely over governed views, but may not reach past them to a raw table.
  // This must be judged BEFORE expansion — afterwards, the tables a view reads
  // are indistinguishable from tables the caller named, and the scope guard
  // (which only ever sees the expanded SQL) would have to admit both or neither.
  if (viewsOnly) {
    const direct = directBaseTables(sql, views, dialect);
    if (direct === null) {
      return { status: 'blocked' as const, reason: 'SQL could not be parsed to verify it uses only governed views.' };
    }
    if (direct.length > 0) {
      const names = direct.map((t) => t.replace(/[^A-Za-z0-9_.]/g, '')).join(', ');
      const available = views.map((v) => v.name).join(', ');
      return {
        status: 'blocked' as const,
        reason: `This connection is limited to governed views, so ${names} cannot be read directly. Available views: ${available || '(none defined yet)'}`,
      };
    }
  }

  return expandVirtualViews(sql, views, dialect, { viewsOnly });
}

const viewCache = new Map<string, VirtualViewDef[]>();

async function getCachedViews(connectionId: string): Promise<VirtualViewDef[]> {
  const hit = viewCache.get(connectionId);
  if (hit) return hit;
  const defs = await listActiveViewDefs(connectionId);
  viewCache.set(connectionId, defs);
  return defs;
}

/** Called by every write path — a stale cache would run an old definition. */
export function invalidateViewCache(connectionId: string): void {
  viewCache.delete(connectionId);
}
