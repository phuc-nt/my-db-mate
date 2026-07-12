import { NextResponse } from 'next/server';
import { rerunNotebook } from '../../../../../services/notebook-service';

export const runtime = 'nodejs';
export const maxDuration = 120;

/** POST → re-execute the notebook's queries against current data. */
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const res = await rerunNotebook(id);
  return NextResponse.json(res, { status: 'error' in res ? 400 : 200 });
}
