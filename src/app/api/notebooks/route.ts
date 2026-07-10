import { NextResponse } from 'next/server';
import { createNotebookFromSession, listNotebooks } from '../../../services/notebook-service';

export const runtime = 'nodejs';

/** List notebooks — all, or one connection's with ?connectionId=. */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const connectionId = url.searchParams.get('connectionId');
  return NextResponse.json(await listNotebooks(connectionId ?? undefined));
}

/** Save a chat session as a notebook. */
export async function POST(req: Request) {
  const { connectionId, sessionId, title } = await req.json();
  if (typeof connectionId !== 'string' || typeof sessionId !== 'string') {
    return NextResponse.json({ error: 'connectionId and sessionId required' }, { status: 400 });
  }
  const nb = await createNotebookFromSession(connectionId, sessionId, (title ?? 'Notebook').toString());
  return NextResponse.json(nb, { status: 201 });
}
