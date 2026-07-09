import { NextResponse } from 'next/server';
import { addEvalQuery, listEvalQueries, listEvalRuns, runEval } from '../../../../../services/eval-service';

export const runtime = 'nodejs';
export const maxDuration = 300;

/** GET → gold queries + past runs. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [queries, runs] = await Promise.all([listEvalQueries(id), listEvalRuns(id)]);
  return NextResponse.json({ queries, runs });
}

/** POST → { action:'add', question, goldSql } or { action:'run' }. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await req.json();
  try {
    if (body.action === 'add') {
      const row = await addEvalQuery({ connectionId: id, question: body.question, goldSql: body.goldSql, complexity: body.complexity });
      return NextResponse.json(row, { status: 201 });
    }
    if (body.action === 'run') {
      return NextResponse.json(await runEval(id));
    }
    return NextResponse.json({ error: 'unknown action' }, { status: 400 });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
  }
}
