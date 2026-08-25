/**
 * Install health, readable from a terminal (`setup.sh --check`) and from the
 * onboarding UI. Unauthenticated like the rest of the app (single-user by
 * design), so the service it delegates to reports statuses only — never key
 * material, never connection strings.
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSetupHealth } from '@/core/app-state/setup-health-service';

// The health service touches node:fs, the pg driver, and the local embedding
// model, so this route cannot run on any lighter runtime. `live=1` adds a real
// provider round-trip on top of the embedding warm-up wait.
export const runtime = 'nodejs';
export const maxDuration = 60;

export async function GET(req: NextRequest) {
  // Opt-in only: proving the key works spends a token on the user's account.
  const live = req.nextUrl.searchParams.get('live') === '1';
  const health = await getSetupHealth({ live });
  // A degraded install still answers 200 — the payload IS the answer, and a
  // non-2xx would make `curl -f` hide exactly the detail the user needs.
  return NextResponse.json(health);
}
