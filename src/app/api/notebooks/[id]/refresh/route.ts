import { NextResponse } from 'next/server';
import { rerunNotebook } from '@/modules/notebooks';
import { requireModule } from '@/core/require-module';

export const runtime = 'nodejs';
export const maxDuration = 120;

/** POST → re-execute the notebook's queries against current data. */
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const disabled = requireModule('notebooks');
  if (disabled) return disabled;
  const { id } = await params;
  const res = await rerunNotebook(id);
  return NextResponse.json(res, { status: 'error' in res ? 400 : 200 });
}
