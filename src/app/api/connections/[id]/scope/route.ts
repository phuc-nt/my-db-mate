import { NextResponse } from 'next/server';
import { getScope, setScope, type SchemaScope } from '../../../../../services/schema-scope-service';
import { evictImpactedSnapshots, findImpactedArtifacts, pauseImpactedSchedules } from '../../../../../services/schema-scope-impact-service';

export const runtime = 'nodejs';

/** Current scope plus what a caller would need to render the editor. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return NextResponse.json({ scope: await getScope(id) });
}

/** Names arrive from a form; keep them to identifier characters so nothing
 *  crafted can travel into a prompt or a message downstream.
 *
 *  An entry that is only wildcards and separators (`*`, `.*`, `*.*`) is dropped
 *  rather than cleaned: it would name no table in particular while matching
 *  every one, turning the act of setting a boundary into removing it. A scope
 *  that admits everything must be expressed by clearing the scope, where the UI
 *  says so plainly, not by an entry that quietly reads as a grant. */
function cleanList(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out = v
    .filter((x): x is string => typeof x === 'string')
    .map((x) => x.trim().replace(/[^A-Za-z0-9_.*-]/g, ''))
    .filter((x) => x.length > 0 && /[A-Za-z0-9_]/.test(x.replace(/\*/g, '')));
  return out.length > 0 ? out : undefined;
}

/**
 * Preview or apply a scope. `dryRun` reports the artifacts the boundary would
 * break without changing anything, so the owner sees the cost before paying it;
 * applying it also evicts cached extracts of newly-withheld tables and pauses
 * schedules that would otherwise fail unattended every night.
 */
export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await req.json();
  const dryRun = body?.dryRun === true;

  const scope: SchemaScope | null = body?.scope
    ? {
        datasets: cleanList(body.scope.datasets),
        tables: cleanList(body.scope.tables),
        viewsOnly: body.scope.viewsOnly === true ? true : undefined,
      }
    : null;

  const impacted = await findImpactedArtifacts(id, scope);
  if (dryRun) return NextResponse.json({ dryRun: true, scope, impacted });

  const { evictedSnapshots } = await setScope(id, scope);
  const evictedCaches = await evictImpactedSnapshots(id, scope, impacted);
  const pausedScheduleIds = await pauseImpactedSchedules(impacted);
  return NextResponse.json({ scope, impacted, evictedSnapshots, evictedCaches, pausedScheduleIds });
}
