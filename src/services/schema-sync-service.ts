/**
 * Schema-sync: introspect a target DB via its provider and persist a snapshot
 * (tables, columns, foreign keys) into the app DB. Re-sync replaces the snapshot.
 */
import { eq } from 'drizzle-orm';
import { db } from '../db/client';
import { schemaTables, schemaColumns, schemaForeignKeys, connections } from '../db/schema';
import { getProvider } from './connection-service';

export async function syncSchema(connectionId: string) {
  const provider = await getProvider(connectionId);
  try {
    const introspected = await provider.introspectSchema();

    // Replace previous snapshot for this connection.
    await db.delete(schemaTables).where(eq(schemaTables.connectionId, connectionId));
    await db.delete(schemaForeignKeys).where(eq(schemaForeignKeys.connectionId, connectionId));

    // Insert tables and remember their ids for column linkage.
    const tableIdByName = new Map<string, string>();
    for (const t of introspected.tables) {
      const [row] = await db
        .insert(schemaTables)
        .values({
          connectionId,
          schemaName: t.schemaName,
          tableName: t.tableName,
          rowCount: t.rowCount,
        })
        .returning();
      tableIdByName.set(`${t.schemaName ?? ''}.${t.tableName}`, row.id);
    }

    // Columns.
    for (const c of introspected.columns) {
      const tableId = tableIdByName.get(`${c.schemaName ?? ''}.${c.tableName}`);
      if (!tableId) continue;
      await db.insert(schemaColumns).values({
        tableId,
        columnName: c.columnName,
        dataType: c.dataType,
        isNullable: c.isNullable,
        isPrimaryKey: c.isPrimaryKey,
        ordinalPosition: c.ordinalPosition,
      });
    }

    // Foreign keys.
    for (const fk of introspected.foreignKeys) {
      await db.insert(schemaForeignKeys).values({
        connectionId,
        fromTable: fk.fromTable,
        fromColumn: fk.fromColumn,
        toTable: fk.toTable,
        toColumn: fk.toColumn,
      });
    }

    return {
      tables: introspected.tables.length,
      columns: introspected.columns.length,
      foreignKeys: introspected.foreignKeys.length,
    };
  } finally {
    await provider.close();
  }
}

/** Compact schema summary string for the agent's system prompt. */
export async function getSchemaSummary(connectionId: string): Promise<string> {
  const tables = await db
    .select()
    .from(schemaTables)
    .where(eq(schemaTables.connectionId, connectionId));
  const fks = await db
    .select()
    .from(schemaForeignKeys)
    .where(eq(schemaForeignKeys.connectionId, connectionId));

  // BigQuery requires table refs qualified with their dataset; present names to the
  // model as `dataset.table` so the SQL it writes for run_sql is valid. Other dialects
  // resolve a bare name against the default schema, so keep the bare form for them.
  const [conn] = await db.select({ dialect: connections.dialect }).from(connections)
    .where(eq(connections.id, connectionId));
  const qualify = conn?.dialect === 'bigquery';

  const lines: string[] = [];
  for (const t of tables) {
    const cols = await db
      .select()
      .from(schemaColumns)
      .where(eq(schemaColumns.tableId, t.id));
    const colStr = cols
      .sort((a, b) => a.ordinalPosition - b.ordinalPosition)
      .map((c) => `${c.columnName} ${c.dataType}${c.isPrimaryKey ? ' PK' : ''}`)
      .join(', ');
    const name = qualify && t.schemaName ? `${t.schemaName}.${t.tableName}` : t.tableName;
    lines.push(`${name}(${colStr})`);
  }
  for (const fk of fks) {
    lines.push(`FK: ${fk.fromTable}.${fk.fromColumn} -> ${fk.toTable}.${fk.toColumn}`);
  }
  return lines.join('\n');
}
