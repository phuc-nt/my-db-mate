import { NextResponse } from 'next/server';
import { importGlossaryDocument } from '../../../../../services/document-import-service';

export const runtime = 'nodejs';

const MAX_BYTES = 512 * 1024; // 512KB cap — a glossary/data-dictionary, not a corpus

/** POST → import a glossary document (CSV / markdown table / "term: def" lines) as
 *  pending glossary suggestions. Body: { text, sourceName? } */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await req.json().catch(() => ({}));
  const text = String(body.text ?? '');
  if (!text.trim()) return NextResponse.json({ error: 'text required' }, { status: 400 });
  if (Buffer.byteLength(text, 'utf8') > MAX_BYTES) return NextResponse.json({ error: 'file too large (max 512KB)' }, { status: 400 });
  try {
    const result = await importGlossaryDocument(id, text, String(body.sourceName ?? 'upload'));
    return NextResponse.json(result);
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
  }
}
