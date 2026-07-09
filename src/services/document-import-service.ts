/**
 * P5e — Document/glossary direct-import (KISS per red-team H2).
 *
 * The red-team argued: the case where "mining a document" actually yields value is
 * a DATA DICTIONARY — which is *already* a glossary and can be imported directly,
 * at 1/10th the cost of an ingest→chunk→embed→RAG pipeline. So instead of RAG, this
 * parses a structured glossary file (CSV `term,definition[,sqlMapping]` or a markdown
 * table / bullet list) into PENDING glossary suggestions the DBA reviews + accepts.
 *
 * Free-form prose docs are out of scope (unproven extraction value); if that need
 * appears, a mining pass can be added later. Inbox-gated like everything else.
 */
import { db } from '../db/client';
import { knowledgeSuggestions } from '../db/context-schema';

export interface ImportResult { parsed: number; created: number; format: string }

/** Parse `term,definition,sqlMapping?` rows from CSV or a markdown table/list. */
function parseGlossary(text: string): { term: string; definition: string; sqlMapping?: string }[] {
  const out: { term: string; definition: string; sqlMapping?: string }[] = [];
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  for (const line of lines) {
    // Skip obvious headers / separators.
    if (/^(term\s*[,|]|[-|: ]+$|#)/i.test(line)) continue;
    // Markdown table row: | term | definition | sql |
    let cells: string[] | null = null;
    if (line.includes('|')) {
      cells = line.split('|').map((c) => c.trim()).filter((_, i, a) => !(i === 0 && a[0] === '') && !(i === a.length - 1 && a[a.length - 1] === ''));
    } else if (line.includes(',')) {
      // CSV (naive — good enough for a dictionary; quoted commas rare here).
      cells = line.split(',').map((c) => c.trim().replace(/^"|"$/g, ''));
    } else if (line.includes(':')) {
      // "term: definition" bullet/line form.
      const idx = line.indexOf(':');
      cells = [line.slice(0, idx).replace(/^[-*]\s*/, '').trim(), line.slice(idx + 1).trim()];
    }
    if (!cells || cells.length < 2 || !cells[0] || !cells[1]) continue;
    out.push({ term: cells[0], definition: cells[1], sqlMapping: cells[2] || undefined });
  }
  return out;
}

/** Import a glossary document → PENDING glossary suggestions (inbox-gated). */
export async function importGlossaryDocument(connectionId: string, text: string, sourceName: string): Promise<ImportResult> {
  const rows = parseGlossary(text);
  let created = 0;
  for (const r of rows) {
    await db.insert(knowledgeSuggestions).values({
      connectionId, kind: 'glossary',
      payload: { term: r.term, definition: r.definition, sqlMapping: r.sqlMapping, confidence: 'medium' },
      reason: `imported from ${sourceName}`, status: 'pending',
    });
    created++;
  }
  return { parsed: rows.length, created, format: 'glossary' };
}
