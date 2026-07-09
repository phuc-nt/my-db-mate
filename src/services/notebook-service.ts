/**
 * Notebook service (P10-B3). Turn a chat session into a read-only, shareable
 * notebook (turn-by-turn: question → SQL → result table → narrative).
 *
 * Design (from adversarial review):
 * - chat_messages stores user and assistant as SEPARATE rows; a turn pairs a
 *   user message with the following assistant message's parts (red-team F9).
 * - Result rows come from the assistant's `tool-run_sql` parts, which hold UNWRAPPED
 *   DB values. A query that touches a sensitive column is OMITTED from the snapshot
 *   and markdown (red-team H3 — reports block sensitive sources; notebooks must too).
 * - The snapshot is capped by turns AND per-result rows/bytes (red-team H5 — a
 *   session is unbounded, unlike a report's per-source cap).
 * - The renderer builds tables from the snapshot via <ResultTable> and prose via
 *   react-markdown (no rehype-raw) — DB values never string-concat into markdown.
 */
import { and, desc, eq } from 'drizzle-orm';
import { db } from '../db/client';
import { notebooks } from '../db/notebook-schema';
import { getMessages } from './session-service';
import { touchesSensitiveColumns, connectionHasSensitiveColumns } from './query-executor-service';
import { generateShareSlug } from '../lib/share';

const MAX_TURNS = 30;
const MAX_ROWS_PER_RESULT = 200;
const MAX_CELL_CHARS = 500;

interface SqlPart { type: string; input?: { sql?: string }; output?: { columns?: string[]; rows?: unknown[][]; executedSql?: string } }
interface Msg { role: string; content: string; parts: unknown[] | null }

export interface NotebookSnapshot {
  [turnId: string]: { columns: string[]; rows: unknown[][] };
}

function truncateCell(v: unknown): unknown {
  return typeof v === 'string' && v.length > MAX_CELL_CHARS ? v.slice(0, MAX_CELL_CHARS) + '…' : v;
}

/**
 * Build a notebook from a session's messages. Pairs each user turn with the
 * following assistant reply; embeds each run_sql result as a snapshot entry keyed
 * by a stable turnId (unless it touches a sensitive column, in which case it's
 * omitted). Returns the created notebook row.
 */
export async function createNotebookFromSession(connectionId: string, sessionId: string, title: string) {
  const messages = (await getMessages(sessionId)) as unknown as Msg[];

  // A SELECT * names no columns, so touchesSensitiveColumns can't see a sensitive
  // one it expands to — when the connection has any sensitive column, omit wildcard
  // results too (red-team: same guard the dashboard/report share surfaces use).
  const hasSensitive = await connectionHasSensitiveColumns(connectionId);

  const snapshot: NotebookSnapshot = {};
  const mdParts: string[] = [`# ${title}\n`];
  let turnCount = 0;

  for (let i = 0; i < messages.length && turnCount < MAX_TURNS; i++) {
    const m = messages[i];
    if (m.role !== 'user') continue;
    turnCount++;
    mdParts.push(`## Q${turnCount}: ${m.content}\n`);

    // The assistant reply is the next message (if any).
    const reply = messages[i + 1];
    if (!reply || reply.role !== 'assistant') continue;

    // Emit each run_sql part: SQL + a snapshot table (unless sensitive).
    const parts = (reply.parts ?? []) as SqlPart[];
    let sqlIndex = 0;
    for (const p of parts) {
      if (p.type !== 'tool-run_sql' || !p.output?.columns) continue;
      const executedSql = p.output.executedSql ?? p.input?.sql ?? '';
      sqlIndex++;
      const turnId = `t${turnCount}_${sqlIndex}`;

      const isSensitive = executedSql && (
        (await touchesSensitiveColumns(connectionId, executedSql)) ||
        (hasSensitive && /\bselect\s+\*/i.test(executedSql))
      );
      if (isSensitive) {
        mdParts.push(`\`\`\`sql\n${executedSql}\n\`\`\`\n_Result omitted — this query reads a column marked sensitive._\n`);
        continue;
      }
      if (executedSql) mdParts.push(`\`\`\`sql\n${executedSql}\n\`\`\`\n`);
      const rows = (p.output.rows ?? []).slice(0, MAX_ROWS_PER_RESULT).map((r) => r.map(truncateCell));
      snapshot[turnId] = { columns: p.output.columns, rows };
      mdParts.push(`{{table:${turnId}}}\n`); // placeholder the renderer replaces with a table
    }

    // The assistant's narrative text.
    if (reply.content?.trim()) mdParts.push(`${reply.content.trim()}\n`);
  }

  const [row] = await db.insert(notebooks).values({
    connectionId, sessionId, title, markdown: mdParts.join('\n'), dataSnapshot: snapshot,
  }).returning({ id: notebooks.id });
  return row;
}

export async function listNotebooks(connectionId: string) {
  return db.select({ id: notebooks.id, title: notebooks.title, shareSlug: notebooks.shareSlug, createdAt: notebooks.createdAt })
    .from(notebooks).where(eq(notebooks.connectionId, connectionId)).orderBy(desc(notebooks.createdAt));
}

export async function getNotebook(id: string) {
  const [nb] = await db.select().from(notebooks).where(eq(notebooks.id, id));
  return nb ?? null;
}

export async function deleteNotebook(id: string) {
  await db.delete(notebooks).where(eq(notebooks.id, id));
}

export async function setNotebookShare(id: string, enable: boolean): Promise<string | null> {
  const slug = enable ? generateShareSlug() : null;
  await db.update(notebooks).set({ shareSlug: slug }).where(eq(notebooks.id, id));
  return slug;
}

/** Public share view — markdown + snapshot only, no execution, no SQL leak beyond
 *  what's already in the markdown (the owner's own queries). */
export async function getSharedNotebook(slug: string) {
  const [nb] = await db.select({ title: notebooks.title, markdown: notebooks.markdown, dataSnapshot: notebooks.dataSnapshot })
    .from(notebooks).where(and(eq(notebooks.shareSlug, slug)));
  return nb ?? null;
}
