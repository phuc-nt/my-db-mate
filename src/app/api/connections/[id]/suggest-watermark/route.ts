import { NextResponse } from 'next/server';
import { sampleRows } from '../../../../../services/schema-browser-service';
import { detectWatermarkColumn } from '../../../../../services/accelerator/watermark-detection-service';

export const runtime = 'nodejs';

/** Suggests a candidate watermark column for a table, advisory only — the
 *  caller (schema browser UI) must still route this through an explicit user
 *  confirm before calling PUT /watermark-config. Never enables anything itself. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { table } = await req.json();
  if (typeof table !== 'string' || !table.trim()) {
    return NextResponse.json({ error: 'table required' }, { status: 400 });
  }
  const res = await sampleRows(id, table);
  if (res.status !== 'ok') return NextResponse.json({ error: res.message }, { status: 200 });
  const suggestedColumn = detectWatermarkColumn(res.columns, res.rows);
  return NextResponse.json({ suggestedColumn });
}
