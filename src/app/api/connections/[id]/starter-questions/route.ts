import { NextResponse } from 'next/server';
import { getStarterQuestions } from '../../../../../services/starter-questions-service';

export const runtime = 'nodejs';

/** GET → 3-4 starter questions for an empty chat (verified-first, no LLM). */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const questions = await getStarterQuestions(id);
    return NextResponse.json({ questions });
  } catch {
    return NextResponse.json({ questions: [] });
  }
}
