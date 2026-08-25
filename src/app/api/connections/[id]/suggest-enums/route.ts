import { NextResponse } from 'next/server';
import { suggestEnumAnnotations } from '@/modules/context-studio';
import { requireModule } from '@/core/require-module';

export const runtime = 'nodejs';
export const maxDuration = 120;

/** POST → scan columns, create pending enum-annotation suggestions in the inbox.
 *  Body: { withDrafts?: boolean, maxColumns?: number } */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const disabled = requireModule('context-studio');
  if (disabled) return disabled;
  const { id } = await params;
  const body = await req.json().catch(() => ({}));
  try {
    const result = await suggestEnumAnnotations(id, { withDrafts: Boolean(body.withDrafts), maxColumns: body.maxColumns });
    return NextResponse.json(result);
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
  }
}
