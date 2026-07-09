import { NextResponse } from 'next/server';
import { testConnectionConfig } from '../../../../services/connection-service';

export const runtime = 'nodejs';

/** Test a connection config WITHOUT saving it (the "Test connection" button). */
export async function POST(req: Request) {
  try {
    const body = await req.json();
    const res = await testConnectionConfig(body);
    return NextResponse.json(res);
  } catch (e) {
    // Malformed body throws in req.json() before testConnectionConfig can catch it.
    return NextResponse.json({ ok: false, detail: e instanceof Error ? e.message : 'Invalid request' }, { status: 400 });
  }
}
