import { NextResponse } from 'next/server';
import { exportContextYaml, importContextYaml } from '../../../../../../services/context-yaml-io';

export const runtime = 'nodejs';

/** GET → YAML export of the connection's context. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const yaml = await exportContextYaml(id);
  return new NextResponse(yaml, { headers: { 'content-type': 'text/yaml' } });
}

/** POST → import (replace) context from a YAML body. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    await importContextYaml(id, await req.text());
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
  }
}
