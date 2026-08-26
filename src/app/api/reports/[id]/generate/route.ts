import { NextResponse } from 'next/server';
import { generateReport } from '@/modules/bi';
import { requireModule } from '@/core/require-module';

export const runtime = 'nodejs';
export const maxDuration = 300; // one LLM compose call + source runs

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const disabled = requireModule('bi');
  if (disabled) return disabled;
  const { id } = await params;
  const res = await generateReport(id);
  if ('error' in res) return NextResponse.json({ error: res.error }, { status: 200 });
  return NextResponse.json(res);
}
