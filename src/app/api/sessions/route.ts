import { NextResponse } from 'next/server';
import { createSession, listSessions } from '../../../services/session-service';

export const runtime = 'nodejs';

export async function GET(req: Request) {
  const connectionId = new URL(req.url).searchParams.get('connectionId') ?? undefined;
  return NextResponse.json(await listSessions(connectionId));
}

export async function POST(req: Request) {
  const { connectionId, title } = await req.json();
  const row = await createSession(connectionId, title);
  return NextResponse.json(row, { status: 201 });
}
