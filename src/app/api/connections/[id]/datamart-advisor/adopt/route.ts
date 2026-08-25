/**
 * Adopt chosen statements as in-app virtual views — a governed datamart without
 * touching the warehouse.
 *
 * The proposal arrives from the client, so nothing about its `valid` flag is
 * believed on its own: every adopted statement goes through `createView`, which
 * re-runs the safety verdict, the governed scope check, and the view-name rules.
 * A client that edits the SQL on its way back gets the same treatment as one
 * typed by hand, so there is no shortcut here that the Context Studio does not
 * already offer.
 */
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getConnection } from '@/core/connections/connection-service';
import { adoptAsVirtualViews, ValidatedProposalSchema } from '@/modules/datamart';

export const runtime = 'nodejs';
// Each adopted view is probed for its column list against the real database.
export const maxDuration = 120;

const BodySchema = z.object({
  proposal: ValidatedProposalSchema,
  selection: z.array(z.object({
    martName: z.string(),
    summaryTableName: z.string(),
  })).max(50),
});

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const conn = await getConnection(id);
  if (!conn) return NextResponse.json({ error: 'connection not found' }, { status: 404 });

  const parsed = BodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: 'Malformed adoption payload.' }, { status: 400 });
  }
  try {
    const result = await adoptAsVirtualViews(id, parsed.data.proposal, parsed.data.selection);
    return NextResponse.json(result);
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
