import { NextResponse } from 'next/server';
import { desc, eq, inArray } from 'drizzle-orm';
import { db } from '../../../../../../db/client';
import { scheduledQueries, scheduledRuns } from '../../../../../../db/ecosystem-schema';

export const runtime = 'nodejs';

/** GET ?scheduleId= | ?mode= → recent scheduled_runs (newest first, cap 20).
 *  Powers the Health "monitor findings" block and Automations run history. */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const url = new URL(req.url);
  const scheduleId = url.searchParams.get('scheduleId');
  const mode = url.searchParams.get('mode');

  let scheduleIds: string[];
  if (scheduleId) {
    scheduleIds = [scheduleId];
  } else {
    const scheds = await db.select({ id: scheduledQueries.id, mode: scheduledQueries.mode })
      .from(scheduledQueries).where(eq(scheduledQueries.connectionId, id));
    scheduleIds = scheds.filter((s) => !mode || s.mode === mode).map((s) => s.id);
  }
  if (scheduleIds.length === 0) return NextResponse.json([]);
  const runs = await db.select().from(scheduledRuns)
    .where(inArray(scheduledRuns.scheduleId, scheduleIds))
    .orderBy(desc(scheduledRuns.ranAt)).limit(20);
  return NextResponse.json(runs);
}
