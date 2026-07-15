import { NextResponse } from 'next/server';
import { createConnection, listConnections } from '../../../services/connection-service';

export const runtime = 'nodejs';

export async function GET() {
  const rows = await listConnections();
  // Never leak the encrypted secret / SSH key / service-account material to the client.
  const safe = rows.map(({ secretEncrypted, sshSecretEncrypted, bigqueryServiceAccountJsonEncrypted, ...rest }) => rest);
  return NextResponse.json(safe);
}

export async function POST(req: Request) {
  const body = await req.json();
  try {
    const row = await createConnection(body);
    const { secretEncrypted, sshSecretEncrypted, bigqueryServiceAccountJsonEncrypted, ...safe } = row;
    return NextResponse.json(safe, { status: 201 });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
  }
}
