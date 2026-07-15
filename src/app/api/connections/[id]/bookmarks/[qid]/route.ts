import { NextResponse } from 'next/server';
import { deleteBookmark, listBookmarks } from '../../../../../../services/context-service';
import { executeQuery } from '../../../../../../services/query-executor-service';
import { toJsonSafe } from '../../../../../../lib/json-safe';

export const runtime = 'nodejs';

/** Run a bookmark through the choke point (safety + audit). */
export async function POST(req: Request, { params }: { params: Promise<{ id: string; qid: string }> }) {
  const { id, qid } = await params;
  const { confirmed } = await req.json().catch(() => ({}));
  const bm = (await listBookmarks(id)).find((b) => b.id === qid);
  if (!bm) return NextResponse.json({ error: 'bookmark not found' }, { status: 404 });
  const res = await executeQuery({ connectionId: id, sql: bm.sql, actor: 'bookmark', confirmed: Boolean(confirmed) });
  if (res.status === 'blocked') return NextResponse.json({ status: 'blocked', reason: res.blockedReason });
  if (res.status === 'needs_confirmation') return NextResponse.json({ status: 'needs_confirmation', risk: res.risk, executedSql: res.executedSql });
  if (res.status === 'error') return NextResponse.json({ status: 'error', error: res.errorMessage });
  return NextResponse.json({ status: 'ok', ...toJsonSafe(res.result) });
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string; qid: string }> }) {
  const { id, qid } = await params;
  await deleteBookmark(id, qid);
  return NextResponse.json({ ok: true });
}
