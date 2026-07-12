import { NextResponse } from 'next/server';
import { generateAlternativeSql } from '../../../../../services/alternative-sql-service';

export const runtime = 'nodejs';
export const maxDuration = 60;

/** POST { sql, question?, riskReason? } → { alternative: {sql, risk} | null }.
 *  Called by the confirm panel only; null means "show the single-candidate UI". */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await req.json().catch(() => ({}));
  if (typeof body.sql !== 'string' || !body.sql.trim()) {
    return NextResponse.json({ alternative: null });
  }
  const alternative = await generateAlternativeSql(
    id,
    body.sql,
    typeof body.question === 'string' ? body.question : undefined,
    typeof body.riskReason === 'string' ? body.riskReason : undefined,
  );
  return NextResponse.json({ alternative });
}
