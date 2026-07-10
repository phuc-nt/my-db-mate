import { NextResponse } from 'next/server';
import { mineQueryHistory } from '../../../../../services/query-history-mining-orchestrator';

export const runtime = 'nodejs';
export const maxDuration = 120;

const MAX_PASTE = 1_000_000; // 1MB cap on pasted log input

/** POST → mine the connection's query history into pending inbox suggestions.
 *  Body: { pastedLog?: string } — when absent, auto-reads pg_stat_statements /
 *  performance_schema. Never auto-applies; suggestions land in the inbox. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await req.json().catch(() => ({}));
  const pastedLog = typeof body.pastedLog === 'string' ? body.pastedLog.slice(0, MAX_PASTE) : undefined;
  try {
    const result = await mineQueryHistory(id, { pastedLog });
    return NextResponse.json(result);
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
  }
}
