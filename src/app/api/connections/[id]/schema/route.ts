import { NextResponse } from 'next/server';
import { asc, eq } from 'drizzle-orm';
import { db } from '@/core/db/client';
import { schemaTables, schemaColumns, schemaForeignKeys } from '@/core/db/schema';
import { manualRelationships } from '@/core/db/context-schema';
import { getConnection } from '@/core/connections/connection-service';
import { getScope, isScopeActive, filterTablesToScope, isRefInScope } from '@/core/boundary/schema-scope-service';

export const runtime = 'nodejs';

/** Return the synced schema (tables + columns + FKs + manual relationships) for
 *  the Schema Browser and ERD. Reads the app DB only — never touches the target.
 *
 *  Filtered to the governed scope: a boundary the agent honors but the browser
 *  ignores would still put out-of-scope table and column names on screen, so the
 *  same filter applies here. Edges pointing at a hidden table are dropped too —
 *  otherwise the ERD would draw arrows to names it refuses to show. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const scope = await getScope(id);
  const allTables = await db.select().from(schemaTables)
    .where(eq(schemaTables.connectionId, id))
    .orderBy(asc(schemaTables.tableName));
  const tables = filterTablesToScope(scope, allTables);

  /** Edge endpoints are stored as bare table names, but a dataset-level scope
   *  can only judge a QUALIFIED reference — passing `schemaName: null` would
   *  fail every edge and silently strip the ERD of all its arrows. Resolve the
   *  name against the synced tables to recover its schema first, and fall back
   *  to hiding only names the sync does not know. */
  const schemaByTable = new Map<string, string | null>();
  for (const t of allTables) if (!schemaByTable.has(t.tableName)) schemaByTable.set(t.tableName, t.schemaName);
  const tableVisible = (name: string): boolean => {
    if (!isScopeActive(scope)) return true;
    if (!schemaByTable.has(name)) return false;
    return isRefInScope(scope, { schemaName: schemaByTable.get(name) ?? null, tableName: name });
  };

  // Columns for this connection's tables (join so we only pull relevant rows),
  // grouped by tableId and ordered by ordinal position.
  const columnRows = await db
    .select({
      tableId: schemaColumns.tableId,
      columnName: schemaColumns.columnName,
      dataType: schemaColumns.dataType,
      isNullable: schemaColumns.isNullable,
      isPrimaryKey: schemaColumns.isPrimaryKey,
    })
    .from(schemaColumns)
    .innerJoin(schemaTables, eq(schemaColumns.tableId, schemaTables.id))
    .where(eq(schemaTables.connectionId, id))
    .orderBy(asc(schemaColumns.ordinalPosition));

  const columnsByTable = new Map<string, typeof columnRows>();
  for (const c of columnRows) {
    const arr = columnsByTable.get(c.tableId) ?? [];
    arr.push(c);
    columnsByTable.set(c.tableId, arr);
  }

  const allFks = await db.select().from(schemaForeignKeys).where(eq(schemaForeignKeys.connectionId, id));
  const allRels = await db.select().from(manualRelationships).where(eq(manualRelationships.connectionId, id));
  const fks = allFks.filter((f) => tableVisible(f.fromTable) && tableVisible(f.toTable));
  const rels = allRels.filter((r) => tableVisible(r.fromTable) && tableVisible(r.toTable));
  const conn = await getConnection(id);

  return NextResponse.json({
    dialect: conn?.dialect ?? 'sqlite',
    tables: tables.map((t) => ({
      id: t.id,
      tableName: t.tableName,
      rowCount: t.rowCount,
      columns: (columnsByTable.get(t.id) ?? []).map((c) => ({
        columnName: c.columnName,
        dataType: c.dataType,
        isNullable: c.isNullable,
        isPrimaryKey: c.isPrimaryKey,
      })),
    })),
    // The scope editor must offer tables the scope currently hides — otherwise a
    // boundary could only ever be narrowed, never widened again. Names only: no
    // columns, no row counts, nothing about what those tables contain.
    scope,
    allTableNames: allTables.map((t) => (t.schemaName ? `${t.schemaName}.${t.tableName}` : t.tableName)),
    foreignKeys: fks.map((f) => ({ fromTable: f.fromTable, fromColumn: f.fromColumn, toTable: f.toTable, toColumn: f.toColumn })),
    manualRelationships: rels.map((r) => ({ fromTable: r.fromTable, fromColumn: r.fromColumn, toTable: r.toTable, toColumn: r.toColumn })),
  });
}
