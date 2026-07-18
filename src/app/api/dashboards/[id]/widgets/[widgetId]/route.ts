import { NextResponse } from 'next/server';
import { runWidget, deleteWidget, updateWidgetLayout, type CrossFilter } from '../../../../../../services/dashboard-service';
import { isValidIsoDate } from '../../../../../../lib/sql-param';

const MAX_CROSS_FILTERS = 3;
const COLUMN_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

/** Cross-filters are user-clicked (column, value) pairs. Validate shape here —
 *  column must be a plain identifier, value a primitive or null — before they
 *  reach the AST rewrite. */
export function parseCrossFilters(raw: unknown): { filters: CrossFilter[] } | { error: string } {
  if (raw == null) return { filters: [] };
  if (!Array.isArray(raw)) return { error: 'crossFilters must be an array' };
  if (raw.length > MAX_CROSS_FILTERS) return { error: `at most ${MAX_CROSS_FILTERS} cross-filters` };
  const filters: CrossFilter[] = [];
  for (const f of raw) {
    if (!f || typeof f !== 'object') return { error: 'each cross-filter must be an object' };
    const { column, value } = f as { column?: unknown; value?: unknown };
    if (typeof column !== 'string' || !COLUMN_RE.test(column)) return { error: `invalid cross-filter column` };
    if (value !== null && typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
      return { error: 'cross-filter value must be a string, number, boolean, or null' };
    }
    filters.push({ column, value });
  }
  return { filters };
}

export const runtime = 'nodejs';

/** OWNER refresh: run the widget through the choke point. Optional {from,to}
 *  (ISO dates) runs a {{from}}/{{to}} widget transiently without touching the
 *  cache; anything that isn't a plain calendar date is rejected here AND in
 *  substituteDateRange (defense in depth). */
export async function POST(req: Request, { params }: { params: Promise<{ id: string; widgetId: string }> }) {
  const { widgetId } = await params;
  const body = await req.json().catch(() => ({}));
  let range: { from: string; to: string } | undefined;
  if (body.from != null || body.to != null) {
    if (!isValidIsoDate(String(body.from)) || !isValidIsoDate(String(body.to))) {
      return NextResponse.json({ status: 'error', message: 'from/to must be YYYY-MM-DD dates' }, { status: 400 });
    }
    range = { from: String(body.from), to: String(body.to) };
  }
  const parsed = parseCrossFilters(body.crossFilters);
  if ('error' in parsed) {
    return NextResponse.json({ status: 'error', message: parsed.error }, { status: 400 });
  }
  const res = await runWidget(widgetId, Boolean(body.confirmed), range, parsed.filters);
  return NextResponse.json(res);
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string; widgetId: string }> }) {
  const { widgetId } = await params;
  await deleteWidget(widgetId);
  return NextResponse.json({ ok: true });
}

/** PATCH { size?, position?, chartSpec? } → update widget layout / chart config. */
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string; widgetId: string }> }) {
  const { widgetId } = await params;
  const body = await req.json().catch(() => ({}));
  await updateWidgetLayout(widgetId, { size: body.size, position: body.position, chartSpec: body.chartSpec });
  return NextResponse.json({ ok: true });
}
