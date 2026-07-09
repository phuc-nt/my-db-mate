import { NextResponse } from 'next/server';
import { sampleRows } from '../../../../../services/schema-browser-service';

export const runtime = 'nodejs';

/** Sample rows for a table. Takes {table} (NOT {sql}) — the table is allow-listed
 *  and quoted server-side, then run bounded through the choke point (red-team H1). */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { table } = await req.json();
  if (typeof table !== 'string' || !table.trim()) {
    return NextResponse.json({ error: 'table required' }, { status: 400 });
  }
  const res = await sampleRows(id, table);
  if (res.status !== 'ok') return NextResponse.json({ error: res.message }, { status: 200 });
  return NextResponse.json({ columns: res.columns, rows: res.rows });
}
