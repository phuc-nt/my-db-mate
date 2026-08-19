/**
 * Deterministic schema pruning (P3, RT best-practice) for large schemas (>~200
 * tables): start from tables whose name/alias appears in the question, then expand
 * 1-2 hops along foreign keys + manual relationships. No ML — just graph traversal.
 * For small schemas the full summary is returned unchanged.
 */
import { eq, inArray } from 'drizzle-orm';
import { db } from '../db/client';
import { schemaTables, schemaColumns, schemaForeignKeys, connections } from '../db/schema';
import { manualRelationships, tableAnnotations } from '../db/context-schema';
import { composeSchemaPrefix } from '../lib/table-catalog-prefix';
import { getScope, filterTablesToScope } from './schema-scope-service';
import { composeSummary, describeViews } from './schema-summary-composition';

const PRUNE_THRESHOLD = 200;
const MAX_HOPS = 2;

/** Canonical table key: schema-qualified when a schema/dataset is present. Bare
 *  `tableName` keys collide on multi-dataset BigQuery connections (two datasets
 *  can each have `events`) — a bare-keyed Map silently kept only the LAST one,
 *  presenting the wrong columns/qualification. One helper, used consistently. */
function tableKey(t: { tableName: string; schemaName?: string | null }): string {
  return t.schemaName ? `${t.schemaName}.${t.tableName}` : t.tableName;
}

export async function getPrunedSchemaSummary(connectionId: string, question: string): Promise<string> {
  const allTables = await db.select().from(schemaTables).where(eq(schemaTables.connectionId, connectionId));
  // Governed scope first: pruning is a token optimization, the scope is a
  // boundary. Filtering here means the agent never sees out-of-scope tables to
  // ask about — the executeQuery guard is the enforcement behind it, not the
  // only line of defense. Unscoped connections get the full list, unchanged.
  const scope = await getScope(connectionId);
  const tables = filterTablesToScope(scope, allTables);
  if (tables.length <= PRUNE_THRESHOLD) {
    return buildSummary(connectionId, tables.map((t) => tableKey(t)));
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
  if (seed.size === 0) return buildSummary(connectionId, tables.map((t) => tableKey(t)));

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
  const allTables = await db.select().from(schemaTables).where(eq(schemaTables.connectionId, connectionId));
  // Re-apply the scope here too: this function re-reads the full table list, so
  // resolving a bare name could otherwise pull in a same-named table from an
  // out-of-scope dataset.
  const tables = filterTablesToScope(await getScope(connectionId), allTables);
  // Two-tier resolution: canonical `schema.table` keys hit exactly; a bare name
  // (the FK graph and question-seeding work in bare names — FK rows don't carry
  // schemas) resolves to EVERY table with that name, so a multi-dataset collision
  // renders both instead of silently keeping the last (and a changed key scheme
  // can never produce a silently-empty summary — callers may pass either form).
  const byKey = new Map(tables.map((t) => [tableKey(t), t]));
  const byBare = new Map<string, typeof tables>();
  for (const t of tables) {
    const arr = byBare.get(t.tableName) ?? [];
    arr.push(t);
    byBare.set(t.tableName, arr);
  }
  const resolve = (n: string) => (byKey.has(n) ? [byKey.get(n)!] : byBare.get(n) ?? []);
  const seen = new Set<string>();
  const wanted: typeof tables = [];
  for (const n of tableNames) for (const t of resolve(n)) if (!seen.has(t.id)) { seen.add(t.id); wanted.push(t); }
  const wantedTableIds = wanted.map((t) => t.id);
  // No table resolved — but the governed views still have to be described. Under
  // `viewsOnly` an empty table set is the normal case, not a degenerate one, so
  // returning early here would hand the agent a blank prompt.
  if (wantedTableIds.length === 0) {
    return composeSummary({
      views: await describeViews(connectionId),
      tableLines: [],
      scope: await getScope(connectionId),
      anyCatalogQualified: false,
    });
  }

  // BigQuery requires dataset-qualified refs, plus the owning project when the
  // dataset is shared in from another one; present the name the warehouse itself
  // resolves so the model writes valid run_sql. Bare name for other dialects
  // (default-schema resolution).
  const [conn] = await db.select({ dialect: connections.dialect }).from(connections)
    .where(eq(connections.id, connectionId));
  const dialect = conn?.dialect ?? '';
  const qualify = dialect === 'bigquery';

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
  let anyCatalogQualified = false;
  for (const t of wanted) {
    const cols = colsByTableId.get(t.id) ?? [];
    const colStr = cols.slice().sort((a, b) => a.ordinalPosition - b.ordinalPosition)
      .map((c) => `${c.columnName} ${c.dataType}${c.isPrimaryKey ? ' PK' : ''}`).join(', ');
    const prefix = qualify ? composeSchemaPrefix(dialect, t.catalogName, t.schemaName) : null;
    if (prefix && prefix.includes('.')) anyCatalogQualified = true;
    const label = prefix ? `${prefix}.${t.tableName}` : t.tableName;
    lines.push(`${label}(${colStr})`);
  }

  return composeSummary({
    views: await describeViews(connectionId),
    tableLines: lines,
    scope: await getScope(connectionId),
    anyCatalogQualified,
  });
}
