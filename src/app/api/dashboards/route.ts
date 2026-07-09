import { NextResponse } from 'next/server';
import { listDashboards, createDashboard } from '../../../services/dashboard-service';

export const runtime = 'nodejs';

export async function GET() {
  return NextResponse.json(await listDashboards());
}

export async function POST(req: Request) {
  const { name } = await req.json();
  if (typeof name !== 'string' || !name.trim()) {
    return NextResponse.json({ error: 'name required' }, { status: 400 });
  }
  return NextResponse.json(await createDashboard(name.trim()), { status: 201 });
}
