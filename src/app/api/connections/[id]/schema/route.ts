import { NextResponse } from 'next/server';
import { asc, eq } from 'drizzle-orm';
import { db } from '../../../../../db/client';
import { schemaTables, schemaColumns, schemaForeignKeys } from '../../../../../db/schema';
import { manualRelationships } from '../../../../../db/context-schema';
import { getConnection } from '../../../../../services/connection-service';

export const runtime = 'nodejs';

/** Return the synced schema (tables + columns + FKs + manual relationships) for
 *  the Schema Browser and ERD. Reads the app DB only — never touches the target. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const tables = await db.select().from(schemaTables)
    .where(eq(schemaTables.connectionId, id))
    .orderBy(asc(schemaTables.tableName));

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

  const fks = await db.select().from(schemaForeignKeys).where(eq(schemaForeignKeys.connectionId, id));
  const rels = await db.select().from(manualRelationships).where(eq(manualRelationships.connectionId, id));
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
    foreignKeys: fks.map((f) => ({ fromTable: f.fromTable, fromColumn: f.fromColumn, toTable: f.toTable, toColumn: f.toColumn })),
    manualRelationships: rels.map((r) => ({ fromTable: r.fromTable, fromColumn: r.fromColumn, toTable: r.toTable, toColumn: r.toColumn })),
  });
}
