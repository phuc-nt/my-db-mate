import { NextResponse } from 'next/server';
import {
  deleteWatermarkConfig,
  getWatermarkConfig,
  listWatermarkConfigs,
  setWatermarkConfig,
} from '../../../../../services/accelerator/watermark-config-service';

export const runtime = 'nodejs';

/** Lists all confirmed watermark configs for the connection, or one table's
 *  config when `?table=` is given. */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const table = new URL(req.url).searchParams.get('table');
  if (table) return NextResponse.json(await getWatermarkConfig(id, table));
  return NextResponse.json(await listWatermarkConfigs(id));
}

/** Confirms (creates/replaces) a table's watermark column. This is the ONLY
 *  way incremental refresh gets enabled for a table — never auto-enabled. */
export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { table, watermarkCol } = await req.json();
  if (typeof table !== 'string' || !table.trim() || typeof watermarkCol !== 'string' || !watermarkCol.trim()) {
    return NextResponse.json({ error: 'table and watermarkCol required' }, { status: 400 });
  }
  try {
    return NextResponse.json(await setWatermarkConfig(id, table.trim(), watermarkCol.trim()));
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
  }
}

/** Disables incremental refresh for a table — falls back to full re-extract. */
export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const table = new URL(req.url).searchParams.get('table');
  if (!table) return NextResponse.json({ error: 'table query param required' }, { status: 400 });
  await deleteWatermarkConfig(id, table);
  return NextResponse.json({ ok: true });
}
