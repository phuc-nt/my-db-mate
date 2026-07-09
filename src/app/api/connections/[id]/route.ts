import { NextResponse } from 'next/server';
import { deleteConnection, getConnection, updateConnection } from '../../../../services/connection-service';

export const runtime = 'nodejs';

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const row = await getConnection(id);
  if (!row) return NextResponse.json({ error: 'not found' }, { status: 404 });
  const { secretEncrypted, ...safe } = row;
  return NextResponse.json(safe);
}

/** Edit a connection in place (host/db/user/password/ssl). Re-probes read-only. */
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await req.json();
  try {
    const row = await updateConnection(id, body);
    const { secretEncrypted, ...safe } = row;
    return NextResponse.json(safe);
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
  }
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await deleteConnection(id);
  return NextResponse.json({ ok: true });
}
