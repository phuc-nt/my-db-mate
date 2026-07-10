import { NextResponse } from 'next/server';
import { ensureDemoConnection } from '../../../services/demo-service';

export const runtime = 'nodejs';

/** One-click demo: generate the sample shop DB + connection + seeded context. */
export async function POST() {
  try {
    const result = await ensureDemoConnection();
    return NextResponse.json(result);
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
