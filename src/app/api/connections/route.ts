import { NextResponse } from 'next/server';
import { createConnection, listConnections } from '../../../services/connection-service';

export const runtime = 'nodejs';

export async function GET() {
  const rows = await listConnections();
  // Never leak the encrypted secret to the client.
  const safe = rows.map(({ secretEncrypted, ...rest }) => rest);
  return NextResponse.json(safe);
}

export async function POST(req: Request) {
  const body = await req.json();
  try {
    const row = await createConnection(body);
    const { secretEncrypted, ...safe } = row;
    return NextResponse.json(safe, { status: 201 });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
  }
}
