import { NextResponse } from 'next/server';
import { explainVisual } from '../../../../../services/explain-service';

export const runtime = 'nodejs';

/** EXPLAIN a read-only SELECT and return the estimate + raw plan (plan-only). */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { sql } = await req.json();
  if (typeof sql !== 'string' || !sql.trim()) {
    return NextResponse.json({ error: 'sql required' }, { status: 400 });
  }
  const res = await explainVisual(id, sql);
  if (res.status === 'blocked') return NextResponse.json({ status: 'blocked', message: res.message });
  if (res.status === 'error') return NextResponse.json({ status: 'error', message: res.message });
  return NextResponse.json(res);
}
