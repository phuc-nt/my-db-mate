import { NextResponse } from 'next/server';
import { getSharedNotebook } from '../../../../../services/notebook-service';

export const runtime = 'nodejs';

/** Public read-only notebook share — markdown + snapshot only, no execution. */
export async function GET(_req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const nb = await getSharedNotebook(slug);
  if (!nb) return NextResponse.json({ error: 'not found' }, { status: 404 });
  return NextResponse.json(nb);
}
