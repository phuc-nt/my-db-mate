/**
 * Follow-up question suggestions: after a chat turn completes, propose 2-3 next
 * questions the user might ask. One short LLM call, grounded in the schema and
 * curated context (glossary / verified queries) — the same trust boundary as the
 * main agent prompt.
 *
 * Privacy: the prompt receives the user's question, the result's COLUMN NAMES,
 * and the schema summary — never raw result-set cell values.
 */
import { generateText } from 'ai';
import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import { getSchemaSummary } from './schema-sync-service';
import { getRelevantContext, renderContextForPrompt } from './context-service';

function model() {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error('OPENROUTER_API_KEY missing');
  const openrouter = createOpenRouter({ apiKey });
  return openrouter(process.env.OPENROUTER_MODEL ?? 'qwen/qwen3.7-max');
}

/** Propose up to 3 follow-up questions grounded in the schema + curated context.
 *  `resultColumns` are column NAMES only (no cell values). */
export async function generateFollowups(
  connectionId: string,
  question: string,
  resultColumns?: string[],
): Promise<string[]> {
  const schema = await getSchemaSummary(connectionId);
  const context = renderContextForPrompt(await getRelevantContext(question, connectionId));
  const cols = resultColumns?.length
    ? `\nThe last answer returned these columns: <data>${resultColumns.join(', ')}</data>`
    : '';

  const { text } = await generateText({
    model: model(),
    prompt:
      `You suggest follow-up questions for a database chat assistant.\n` +
      `The user just asked: "${question}"${cols}\n\n` +
      `Database schema:\n${schema}\n` +
      (context ? `\nCurated context:\n${context}\n` : '') +
      `\nPropose 2-3 SHORT natural-language follow-up questions the user might ask next. ` +
      `Each must be answerable from THIS schema. Prefer directions the curated context supports. ` +
      `Return ONLY the questions, one per line, no numbering or preamble.`,
  });

  return text
    .split('\n')
    .map((l) => l.replace(/^\s*[-*\d.)]+\s*/, '').trim())
    .filter((l) => l.length > 0 && l.length < 200)
    .slice(0, 3);
}
