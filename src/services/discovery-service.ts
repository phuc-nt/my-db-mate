/**
 * P5d — Discovery pipeline (inbox-gated, cost-capped, on-demand).
 *
 * Trust model (post red-team): everything discovery produces goes to the PENDING
 * `knowledge_suggestions` inbox — never auto-applied to the generation context.
 * The DBA reviews + 1-click accepts. This closes the poison path the red-team
 * proved (the eval-guard was inoperative at fresh-connect).
 *
 * On-demand (a button), NOT an async background job — the app has no worker/queue
 * (red-team C1), and a bounded synchronous scan is fine for the dogfood scale.
 * Cost-capped: at most `maxTables` tables described in ONE batched LLM call, so a
 * 300-table warehouse can't trigger runaway spend.
 *
 * Enum value→meaning is deliberately NOT discovered here — the moat test proved the
 * LLM guesses it wrong; that path is the human-supplied enum-accelerator (P5a).
 * Discovery covers what the model IS good at as a *draft*: table/column descriptions
 * and FK-less relationship candidates — still inbox-gated so a human confirms.
 */
import { generateText } from 'ai';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { db } from '../db/client';
import { schemaTables, schemaColumns } from '../db/schema';
import { knowledgeSuggestions } from '../db/context-schema';
import { getModel } from './llm-service';

const DEFAULT_MAX_TABLES = 40;

const DISCOVERY = z.object({
  tables: z.array(z.object({
    tableName: z.string(),
    description: z.string().optional(),
    businessAlias: z.string().optional(),
  })).optional().default([]),
  relationships: z.array(z.object({
    fromTable: z.string(), fromColumn: z.string(), toTable: z.string(), toColumn: z.string(),
  })).optional().default([]),
});

export interface DiscoveryResult { tablesScanned: number; suggestionsCreated: number }

/**
 * Describe up to `maxTables` tables + propose FK-less relationships in ONE LLM call,
 * writing each as a PENDING suggestion. Bounded cost; nothing auto-applied.
 */
export async function runDiscovery(connectionId: string, opts?: { maxTables?: number }): Promise<DiscoveryResult> {
  const maxTables = opts?.maxTables ?? DEFAULT_MAX_TABLES;
  const tables = (await db.select().from(schemaTables).where(eq(schemaTables.connectionId, connectionId))).slice(0, maxTables);
  if (tables.length === 0) return { tablesScanned: 0, suggestionsCreated: 0 };

  // Build a compact schema description for the single batched call.
  const lines: string[] = [];
  for (const t of tables) {
    const cols = await db.select().from(schemaColumns).where(eq(schemaColumns.tableId, t.id));
    lines.push(`${t.tableName}(${cols.map((c) => `${c.columnName} ${c.dataType}${c.isPrimaryKey ? ' PK' : ''}`).join(', ')})`);
  }

  let parsed: z.infer<typeof DISCOVERY>;
  try {
    const { text } = await generateText({
      model: await getModel(),
      system:
        'You draft DB documentation from a schema. Return STRICT JSON: ' +
        '{"tables":[{"tableName","description","businessAlias"}],"relationships":[{"fromTable","fromColumn","toTable","toColumn"}]}. ' +
        'descriptions: one short sentence of what the table holds. businessAlias: a natural name if the table name is abbreviated. ' +
        'relationships: only propose a join when column naming strongly implies an FK (e.g. book_id -> books.id) that is NOT already declared. ' +
        'Do NOT invent enum-value meanings. No markdown, JSON only.',
      prompt: `Schema:\n${lines.join('\n')}`,
    });
    parsed = DISCOVERY.parse(JSON.parse(text.replace(/```json|```/g, '').trim()));
  } catch {
    return { tablesScanned: tables.length, suggestionsCreated: 0 };
  }

  let created = 0;
  const tableNames = new Set(tables.map((t) => t.tableName));
  for (const t of parsed.tables) {
    if (!tableNames.has(t.tableName) || (!t.description && !t.businessAlias)) continue;
    await db.insert(knowledgeSuggestions).values({
      connectionId, kind: 'table_annotation',
      payload: { tableName: t.tableName, description: t.description, businessAlias: t.businessAlias, confidence: 'medium' },
      reason: 'discovery: drafted table description', status: 'pending',
    });
    created++;
  }
  for (const r of parsed.relationships) {
    if (!tableNames.has(r.fromTable) || !tableNames.has(r.toTable)) continue;
    await db.insert(knowledgeSuggestions).values({
      connectionId, kind: 'relationship',
      payload: { fromTable: r.fromTable, fromColumn: r.fromColumn, toTable: r.toTable, toColumn: r.toColumn },
      reason: 'discovery: inferred relationship', status: 'pending',
    });
    created++;
  }
  return { tablesScanned: tables.length, suggestionsCreated: created };
}
