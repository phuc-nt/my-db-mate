import { NextResponse } from 'next/server';
import { and, eq } from 'drizzle-orm';
import { db } from '../../../../../db/client';
import { queryFeedback } from '../../../../../db/feedback-schema';

export const runtime = 'nodejs';

const REASONS = ['wrong-data', 'missing-context', 'misunderstood', 'other'];

/** POST { question, sql, reason, note?, sessionId? } → { id }. One row per
 *  thumbs-down submit, whether or not the user goes on to fix the SQL. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await req.json().catch(() => ({}));
  if (typeof body.question !== 'string' || typeof body.sql !== 'string' || !REASONS.includes(body.reason)) {
    return NextResponse.json({ error: 'question, sql, reason required' }, { status: 400 });
  }
  const [row] = await db.insert(queryFeedback).values({
    connectionId: id,
    question: body.question.slice(0, 4000),
    sqlWrong: body.sql.slice(0, 20000),
    reason: body.reason,
    note: typeof body.note === 'string' && body.note.trim() ? body.note.slice(0, 4000) : null,
    sessionId: typeof body.sessionId === 'string' && body.sessionId ? body.sessionId : null,
  }).returning({ id: queryFeedback.id });
  return NextResponse.json({ id: row.id }, { status: 201 });
}

/** PATCH { feedbackId, fixedVerifiedQueryId } — link the correction the user saved. */
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await req.json().catch(() => ({}));
  if (typeof body.feedbackId !== 'string' || typeof body.fixedVerifiedQueryId !== 'string') {
    return NextResponse.json({ error: 'feedbackId + fixedVerifiedQueryId required' }, { status: 400 });
  }
  await db.update(queryFeedback)
    .set({ fixedVerifiedQueryId: body.fixedVerifiedQueryId })
    .where(and(eq(queryFeedback.id, body.feedbackId), eq(queryFeedback.connectionId, id)));
  return NextResponse.json({ ok: true });
}
