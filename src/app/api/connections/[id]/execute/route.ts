import { NextResponse } from 'next/server';
import { executeQuery } from '../../../../../services/query-executor-service';

export const runtime = 'nodejs';

/** Run one (possibly user-edited) SQL against a connection — same safety choke
 *  point as the chat agent (validate → execute → audit). Powers "edit SQL + re-run". */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { sql, sessionId, confirmed } = await req.json();
  if (typeof sql !== 'string' || !sql.trim()) {
    return NextResponse.json({ error: 'sql required' }, { status: 400 });
  }
  const res = await executeQuery({ connectionId: id, sql, sessionId, actor: 'owner', confirmed: Boolean(confirmed) });
  if (res.status === 'blocked') return NextResponse.json({ status: 'blocked', reason: res.blockedReason }, { status: 200 });
  if (res.status === 'needs_confirmation') return NextResponse.json({ status: 'needs_confirmation', risk: res.risk, executedSql: res.executedSql }, { status: 200 });
  if (res.status === 'error') return NextResponse.json({ status: 'error', error: res.errorMessage, executedSql: res.executedSql }, { status: 200 });
  return NextResponse.json({ status: 'ok', ...res.result, executedSql: res.executedSql });
}
