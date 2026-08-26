import { NextResponse } from 'next/server';
import { listDashboards, createDashboard } from '@/modules/bi';
import { requireModule } from '@/core/require-module';

export const runtime = 'nodejs';

export async function GET() {
  const disabled = requireModule('bi');
  if (disabled) return disabled;
  return NextResponse.json(await listDashboards());
}

export async function POST(req: Request) {
  const disabled = requireModule('bi');
  if (disabled) return disabled;
  const { name } = await req.json();
  if (typeof name !== 'string' || !name.trim()) {
    return NextResponse.json({ error: 'name required' }, { status: 400 });
  }
  return NextResponse.json(await createDashboard(name.trim()), { status: 201 });
}
