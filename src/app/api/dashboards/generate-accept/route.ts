import { NextResponse } from 'next/server';
import { acceptDashboardProposal } from '../../../../services/dashboard-generation-service';

export const runtime = 'nodejs';

/** POST { connectionId, dashboardTitle, existingDashboardId?, widgets:[{title,sql,chartSpec?}] }
 *  → creates the dashboard (or appends to existingDashboardId) and pins the
 *  selected widgets in one request. A freshly-created dashboard with zero
 *  successful pins is deleted (no empty orphan). */
export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const connectionId = typeof body.connectionId === 'string' ? body.connectionId : '';
  const dashboardTitle = typeof body.dashboardTitle === 'string' ? body.dashboardTitle : '';
  const existingDashboardId = typeof body.existingDashboardId === 'string' ? body.existingDashboardId : undefined;
  const widgets = Array.isArray(body.widgets)
    ? body.widgets.filter((w: unknown) => w && typeof w === 'object' && typeof (w as { title?: unknown }).title === 'string' && typeof (w as { sql?: unknown }).sql === 'string')
    : [];
  if (!connectionId || widgets.length === 0) {
    return NextResponse.json({ ok: false, error: 'connectionId and at least one widget required' }, { status: 400 });
  }
  const result = await acceptDashboardProposal({ connectionId, dashboardTitle, existingDashboardId, widgets });
  return NextResponse.json(result);
}
