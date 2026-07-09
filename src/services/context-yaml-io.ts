/**
 * Export/import a connection's context layer as a single YAML file — for Git
 * backup, review, and portability. Structure is stable so diffs are meaningful.
 * Import replaces the connection's context (re-embeds glossary + verified queries).
 */
import { stringify, parse } from 'yaml';
import { eq } from 'drizzle-orm';
import { db } from '../db/client';
import {
  tableAnnotations, columnAnnotations, glossaryTerms, manualRelationships, verifiedQueries,
} from '../db/context-schema';
import { embed } from './embedding-service';

interface ContextYaml {
  tableAnnotations: { tableName: string; description?: string; businessAlias?: string; isDeprecated?: boolean }[];
  columnAnnotations: { tableName: string; columnName: string; description?: string; businessAlias?: string; isSensitive?: boolean }[];
  glossary: { term: string; definition: string; sqlMapping?: string; synonyms?: string[] }[];
  relationships: { fromTable: string; fromColumn: string; toTable: string; toColumn: string; note?: string }[];
  verifiedQueries: { question: string; sql: string; tablesUsed?: string[] }[];
}

export async function exportContextYaml(connectionId: string): Promise<string> {
  const [tAnn, cAnn, gloss, rels, verified] = await Promise.all([
    db.select().from(tableAnnotations).where(eq(tableAnnotations.connectionId, connectionId)),
    db.select().from(columnAnnotations).where(eq(columnAnnotations.connectionId, connectionId)),
    db.select().from(glossaryTerms).where(eq(glossaryTerms.connectionId, connectionId)),
    db.select().from(manualRelationships).where(eq(manualRelationships.connectionId, connectionId)),
    db.select().from(verifiedQueries).where(eq(verifiedQueries.connectionId, connectionId)),
  ]);
  const doc: ContextYaml = {
    tableAnnotations: tAnn.map((t) => ({ tableName: t.tableName, description: t.description ?? undefined, businessAlias: t.businessAlias ?? undefined, isDeprecated: t.isDeprecated || undefined })),
    columnAnnotations: cAnn.map((c) => ({ tableName: c.tableName, columnName: c.columnName, description: c.description ?? undefined, businessAlias: c.businessAlias ?? undefined, isSensitive: c.isSensitive || undefined })),
    glossary: gloss.map((g) => ({ term: g.term, definition: g.definition, sqlMapping: g.sqlMapping ?? undefined, synonyms: g.synonyms ?? undefined })),
    relationships: rels.map((r) => ({ fromTable: r.fromTable, fromColumn: r.fromColumn, toTable: r.toTable, toColumn: r.toColumn, note: r.note ?? undefined })),
    verifiedQueries: verified.map((v) => ({ question: v.question, sql: v.sql, tablesUsed: v.tablesUsed ?? undefined })),
  };
  return stringify(doc);
}

/**
 * Replace this connection's context from a YAML doc (re-embeds), atomically.
 * Embeds ALL rows first (the only failure-prone step), then does delete+insert
 * inside a single transaction — so a bad embed or transient error aborts BEFORE
 * any destructive write, and the whole swap commits or rolls back together.
 * Prevents wiping the curated moat on partial failure (code-review H1).
 */
export async function importContextYaml(connectionId: string, yamlText: string): Promise<void> {
  const doc = parse(yamlText) as ContextYaml;

  // Embed everything up front (before touching the DB).
  const glossaryRows = await Promise.all((doc.glossary ?? []).map(async (g) => ({
    connectionId, term: g.term, definition: g.definition, sqlMapping: g.sqlMapping ?? null,
    synonyms: g.synonyms ?? null, embedding: await embed(`${g.term}: ${g.definition}`),
  })));
  const verifiedRows = await Promise.all((doc.verifiedQueries ?? []).map(async (v) => ({
    connectionId, question: v.question, sql: v.sql, tablesUsed: v.tablesUsed ?? null,
    embedding: await embed(v.question),
  })));

  await db.transaction(async (tx) => {
    await tx.delete(tableAnnotations).where(eq(tableAnnotations.connectionId, connectionId));
    await tx.delete(columnAnnotations).where(eq(columnAnnotations.connectionId, connectionId));
    await tx.delete(glossaryTerms).where(eq(glossaryTerms.connectionId, connectionId));
    await tx.delete(manualRelationships).where(eq(manualRelationships.connectionId, connectionId));
    await tx.delete(verifiedQueries).where(eq(verifiedQueries.connectionId, connectionId));

    for (const t of doc.tableAnnotations ?? []) await tx.insert(tableAnnotations).values({ connectionId, ...t });
    for (const c of doc.columnAnnotations ?? []) await tx.insert(columnAnnotations).values({ connectionId, ...c });
    if (glossaryRows.length) await tx.insert(glossaryTerms).values(glossaryRows);
    for (const r of doc.relationships ?? []) await tx.insert(manualRelationships).values({ connectionId, ...r });
    if (verifiedRows.length) await tx.insert(verifiedQueries).values(verifiedRows);
  });
}
