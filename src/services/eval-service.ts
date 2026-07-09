/**
 * Eval harness (P3, RT-F12). Runs gold NL→SQL pairs against a connection and
 * scores the agent's generated SQL two ways:
 *   - execution match: same result rows (order-normalized hash)
 *   - structural match: same column set (catches wrong-shape answers)
 * Run against a STABLE fixture/snapshot DB, not live production, so gold results
 * are reproducible. Rows are hashed (not held) to bound memory.
 */
import { eq } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import { db } from '../db/client';
import { evalQueries, evalRuns, evalResults } from '../db/intelligence-schema';
import { getConnection, getProvider } from './connection-service';
import { runAgentAnswer } from './agent-service';
import { executeQuery } from './query-executor-service';

export async function addEvalQuery(input: { connectionId: string; question: string; goldSql: string; complexity?: string }) {
  const [row] = await db.insert(evalQueries).values(input).returning();
  return row;
}

export async function listEvalQueries(connectionId: string) {
  return db.select().from(evalQueries).where(eq(evalQueries.connectionId, connectionId));
}

function hashRows(rows: unknown[][]): string {
  // Values only (NOT column names) so `COUNT(*)` and `COUNT(*) AS n` match on
  // execution — column naming is the structural check's job. Each value is
  // type-tagged so 1 (number) ≠ "1" (string) and NULL ≠ the literal "NULL" (M3).
  const tag = (v: unknown): string => {
    if (v == null) return 'ø';
    return `${typeof v}:${String(v)}`;
  };
  const rowStrs = rows.map((r) => r.map(tag).join('|C|')).sort();
  return createHash('sha256').update(rowStrs.join('|R|')).digest('hex');
}

/** Extract the final SQL the agent ran from its answer — fenced blocks only, so
 *  prose isn't captured as SQL (M4). The agent's system prompt asks it to show
 *  the final SQL in a ```sql block. Unfenced → treat as "no SQL". */
function extractSql(text: string): string | null {
  const fenced = /```sql\s*([\s\S]*?)```/i.exec(text) ?? /```\s*(SELECT[\s\S]*?)```/i.exec(text);
  return fenced ? fenced[1].trim().replace(/;\s*$/, '') : null;
}

/** Run all gold queries for a connection and record a run. */
export async function runEval(connectionId: string) {
  const conn = await getConnection(connectionId);
  if (!conn) throw new Error('connection not found');
  const golds = await listEvalQueries(connectionId);
  if (golds.length === 0) throw new Error('no gold queries');

  const [run] = await db.insert(evalRuns).values({
    connectionId, total: golds.length, executionMatch: 0, structuralMatch: 0, model: process.env.OPENROUTER_MODEL ?? 'qwen/qwen3.7-max',
  }).returning();

  const provider = await getProvider(connectionId);
  let execMatches = 0;
  let structMatches = 0;

  try {
    for (const g of golds) {
      // Gold result (executed directly, trusted).
      const goldRes = await provider.executeReadOnly(g.goldSql);
      const goldHash = hashRows(goldRes.rows);

      // Generated: ask the agent, extract its SQL, execute through the safety layer.
      const answer = await runAgentAnswer({ connectionId, dialect: conn.dialect, question: g.question });
      const genSql = extractSql(answer.text);
      let exec = false, struct = false, note = '';
      if (!genSql) {
        note = 'no SQL extracted from answer';
      } else {
        const genRes = await executeQuery({ connectionId, sql: genSql, confirmed: true });
        if (genRes.status === 'ok') {
          struct = JSON.stringify([...genRes.result!.columns].sort()) === JSON.stringify([...goldRes.columns].sort());
          exec = hashRows(genRes.result!.rows) === goldHash;
        } else {
          note = `generated SQL ${genRes.status}: ${genRes.blockedReason ?? genRes.errorMessage}`;
        }
      }
      if (exec) execMatches++;
      if (struct) structMatches++;
      await db.insert(evalResults).values({ runId: run.id, evalQueryId: g.id, generatedSql: genSql, executionMatch: exec, structuralMatch: struct, note });
    }
  } finally {
    await provider.close();
  }

  await db.update(evalRuns).set({ executionMatch: execMatches, structuralMatch: structMatches }).where(eq(evalRuns.id, run.id));
  return { runId: run.id, total: golds.length, executionMatch: execMatches, structuralMatch: structMatches };
}

export async function listEvalRuns(connectionId: string) {
  return db.select().from(evalRuns).where(eq(evalRuns.connectionId, connectionId));
}

export async function getEvalResults(runId: string) {
  return db.select().from(evalResults).where(eq(evalResults.runId, runId));
}
