/**
 * Deterministic schema pruning (P3, RT best-practice) for large schemas (>~200
 * tables): start from tables whose name/alias appears in the question, then expand
 * 1-2 hops along foreign keys + manual relationships. No ML — just graph traversal.
 * For small schemas the full summary is returned unchanged.
 */
import { eq, inArray } from 'drizzle-orm';
import { db } from '../db/client';
import { schemaTables, schemaColumns, schemaForeignKeys } from '../db/schema';
import { manualRelationships, tableAnnotations } from '../db/context-schema';

const PRUNE_THRESHOLD = 200;
const MAX_HOPS = 2;

export async function getPrunedSchemaSummary(connectionId: string, question: string): Promise<string> {
  const tables = await db.select().from(schemaTables).where(eq(schemaTables.connectionId, connectionId));
  if (tables.length <= PRUNE_THRESHOLD) {
    return buildSummary(connectionId, tables.map((t) => t.tableName));
  }

  const fks = await db.select().from(schemaForeignKeys).where(eq(schemaForeignKeys.connectionId, connectionId));
  const rels = await db.select().from(manualRelationships).where(eq(manualRelationships.connectionId, connectionId));
  const anns = await db.select().from(tableAnnotations).where(eq(tableAnnotations.connectionId, connectionId));

  // Adjacency from FK + manual relationships (undirected).
  const adj = new Map<string, Set<string>>();
  const link = (a: string, b: string) => {
    if (!adj.has(a)) adj.set(a, new Set());
    if (!adj.has(b)) adj.set(b, new Set());
    adj.get(a)!.add(b); adj.get(b)!.add(a);
  };
  for (const fk of fks) link(fk.fromTable, fk.toTable);
  for (const r of rels) link(r.fromTable, r.toTable);

  // Seed: tables whose name or business alias appears in the question.
  const qLower = question.toLowerCase();
  const aliasMap = new Map(anns.map((a) => [a.tableName, a.businessAlias?.toLowerCase()]));
  const seed = new Set(tables
    .filter((t) => qLower.includes(t.tableName.toLowerCase()) || (aliasMap.get(t.tableName) && qLower.includes(aliasMap.get(t.tableName)!)))
    .map((t) => t.tableName));

  // If nothing seeded, fall back to the full summary (don't starve the agent).
  if (seed.size === 0) return buildSummary(connectionId, tables.map((t) => t.tableName));

  // BFS expand up to MAX_HOPS.
  const included = new Set(seed);
  let frontier = [...seed];
  for (let hop = 0; hop < MAX_HOPS; hop++) {
    const next: string[] = [];
    for (const t of frontier) for (const n of adj.get(t) ?? []) if (!included.has(n)) { included.add(n); next.push(n); }
    frontier = next;
  }
  return buildSummary(connectionId, [...included]);
}

async function buildSummary(connectionId: string, tableNames: string[]): Promise<string> {
  const tables = await db.select().from(schemaTables).where(eq(schemaTables.connectionId, connectionId));
  const byName = new Map(tables.map((t) => [t.tableName, t]));
  const wantedTableIds = tableNames.map((n) => byName.get(n)?.id).filter((id): id is string => !!id);
  if (wantedTableIds.length === 0) return '';

  // Batch-fetch ALL columns for the wanted tables in one query (was N+1 — one
  // query per table inside the loop, on the agent hot path).
  const allCols = await db.select().from(schemaColumns).where(inArray(schemaColumns.tableId, wantedTableIds));
  const colsByTableId = new Map<string, typeof allCols>();
  for (const c of allCols) {
    const arr = colsByTableId.get(c.tableId) ?? [];
    arr.push(c);
    colsByTableId.set(c.tableId, arr);
  }

  const lines: string[] = [];
  for (const name of tableNames) {
    const t = byName.get(name);
    if (!t) continue;
    const cols = colsByTableId.get(t.id) ?? [];
    const colStr = cols.slice().sort((a, b) => a.ordinalPosition - b.ordinalPosition)
      .map((c) => `${c.columnName} ${c.dataType}${c.isPrimaryKey ? ' PK' : ''}`).join(', ');
    lines.push(`${name}(${colStr})`);
  }
  return lines.join('\n');
}
