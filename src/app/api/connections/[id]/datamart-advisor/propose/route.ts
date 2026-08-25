/**
 * Draft the marts this warehouse would have if someone had planned it.
 *
 * Strictly read-only and, on BigQuery, free: inputs come from the app's own
 * database (synced schema, declared relationships, existing profiles, the local
 * audit log), and every proposed SELECT is checked with a dry run, which
 * BigQuery does not bill and which never touches the daily budget. Nothing here
 * writes to the warehouse — the DDL is text for the owner's data team to run.
 *
 * The model call runs inline because there is nothing useful to show until the
 * whole proposal is validated, and this is a single-user app where an owner
 * waiting a minute on a deliberate action is acceptable.
 */
import { NextResponse } from 'next/server';
import { getConnection } from '@/core/connections/connection-service';
import {
  collectAdvisorInputs,
  proposeDatamarts,
  validateProposal,
} from '../../../../../../services/datamart-advisor-service';

export const runtime = 'nodejs';
// One LLM call over a whole schema, then a dry run per proposed statement.
export const maxDuration = 300;

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const conn = await getConnection(id);
  if (!conn) return NextResponse.json({ error: 'connection not found' }, { status: 404 });

  try {
    const inputs = await collectAdvisorInputs(id);
    const draft = await proposeDatamarts(inputs);
    const proposal = await validateProposal(id, draft);
    return NextResponse.json({
      proposal,
      // Reported alongside the proposal rather than folded into it: the owner
      // should read a mart differently when the survey behind it was partial.
      degraded: inputs.degraded,
      degradedReasons: inputs.degradedReasons,
      tablesSurveyed: inputs.tables.length,
      runsRead: inputs.runsRead,
    });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
