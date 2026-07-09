import { NextResponse } from 'next/server';
import { addBookmark, listBookmarks } from '../../../../../services/context-service';

export const runtime = 'nodejs';

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return NextResponse.json(await listBookmarks(id));
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { name, sql } = await req.json();
  if (typeof name !== 'string' || !name.trim() || typeof sql !== 'string' || !sql.trim()) {
    return NextResponse.json({ error: 'name and sql required' }, { status: 400 });
  }
  return NextResponse.json(await addBookmark({ connectionId: id, name: name.trim(), sql }), { status: 201 });
}
