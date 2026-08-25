/**
 * Schema-sync: introspect a target DB via its provider and persist a snapshot
 * (tables, columns, foreign keys) into the app DB. Re-sync replaces the snapshot.
 */
import { eq } from 'drizzle-orm';
import { db } from '@/core/db/client';
import { schemaTables, schemaColumns, schemaForeignKeys, connections } from '@/core/db/schema';
import { getProvider } from '@/core/connections/connection-service';
import { composeSchemaPrefix } from '../lib/table-catalog-prefix';
import { getScope, filterTablesToScope } from './schema-scope-service';
import { composeSummary, describeViews } from './schema-summary-composition';

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
          catalogName: t.catalogName ?? null,
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

/**
 * Compact schema summary string for the agent's system prompt.
 *
 * Filtered to the governed scope, the same boundary the pruned renderer applies
 * and `executeQuery` enforces. Listing a table the executor will refuse teaches
 * the agent to write queries that get blocked, and hands MCP clients the names
 * and columns of tables the connection does not grant.
 */
export async function getSchemaSummary(connectionId: string): Promise<string> {
  const allTables = await db
    .select()
    .from(schemaTables)
    .where(eq(schemaTables.connectionId, connectionId));
  const scope = await getScope(connectionId);
  const tables = filterTablesToScope(scope, allTables);
  const allFks = await db
    .select()
    .from(schemaForeignKeys)
    .where(eq(schemaForeignKeys.connectionId, connectionId));
  // A relationship is only worth showing when the agent can read both ends.
  // Foreign-key rows store bare table names with no schema, so the comparison is
  // on the bare name: two datasets holding a same-named table make this
  // over-inclusive, never under-inclusive. That is the safe direction — an FK
  // line is a hint about how to join, while the scope guard on executeQuery is
  // the enforcement.
  const inScopeNames = new Set(tables.map((t) => t.tableName));
  const fks = allFks.filter((fk) => inScopeNames.has(fk.fromTable) && inScopeNames.has(fk.toTable));

  // BigQuery requires table refs qualified with their dataset, and the owning
  // project too when the dataset is shared in from another one; present names to
  // the model exactly as the warehouse resolves them so the SQL it writes for
  // run_sql is valid. Other dialects resolve a bare name against the default
  // schema, so keep the bare form for them.
  const [conn] = await db.select({ dialect: connections.dialect }).from(connections)
    .where(eq(connections.id, connectionId));
  const dialect = conn?.dialect ?? '';
  const qualify = dialect === 'bigquery';

  const lines: string[] = [];
  let anyCatalogQualified = false;
  for (const t of tables) {
    const cols = await db
      .select()
      .from(schemaColumns)
      .where(eq(schemaColumns.tableId, t.id));
    const colStr = cols
      .sort((a, b) => a.ordinalPosition - b.ordinalPosition)
      .map((c) => `${c.columnName} ${c.dataType}${c.isPrimaryKey ? ' PK' : ''}`)
      .join(', ');
    const prefix = qualify ? composeSchemaPrefix(dialect, t.catalogName, t.schemaName) : null;
    if (prefix && prefix.includes('.')) anyCatalogQualified = true;
    const name = prefix ? `${prefix}.${t.tableName}` : t.tableName;
    lines.push(`${name}(${colStr})`);
  }
  for (const fk of fks) {
    lines.push(`FK: ${fk.fromTable}.${fk.fromColumn} -> ${fk.toTable}.${fk.toColumn}`);
  }
  return composeSummary({
    views: await describeViews(connectionId),
    tableLines: lines,
    scope,
    anyCatalogQualified,
  });
}
