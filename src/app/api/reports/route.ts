import { NextResponse } from 'next/server';
import { listReports, createReport } from '../../../services/report-service';

export const runtime = 'nodejs';

export async function GET() {
  return NextResponse.json(await listReports());
}

export async function POST(req: Request) {
  const { title, instruction, sources } = await req.json();
  if (typeof title !== 'string' || !title.trim()) {
    return NextResponse.json({ error: 'title required' }, { status: 400 });
  }
  const report = await createReport(title.trim(), instruction, Array.isArray(sources) ? sources : []);
  return NextResponse.json(report, { status: 201 });
}
