import { NextResponse } from 'next/server';
import { createApiKey, listApiKeys, revokeApiKey } from '../../../services/api-key-service';

export const runtime = 'nodejs';

export async function GET() {
  return NextResponse.json(await listApiKeys());
}

/** POST { name, connectionId, maxTier } → returns the RAW token once. */
export async function POST(req: Request) {
  const { name, connectionId, maxTier } = await req.json();
  const created = await createApiKey({ name, connectionId, maxTier });
  return NextResponse.json(created, { status: 201 });
}

/** DELETE ?id= → revoke. */
export async function DELETE(req: Request) {
  const id = new URL(req.url).searchParams.get('id');
  if (id) await revokeApiKey(id);
  return NextResponse.json({ ok: true });
}
