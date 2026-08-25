/**
 * Route guard for a disabled feature module.
 *
 * Returns a 404 response when the module is off, `null` when it is on, so a
 * route handler reads as one early-return line.
 *
 * 404 rather than 403: a disabled module does not exist in this deployment, and
 * saying "forbidden" would imply it is there but withheld. It also keeps the
 * guard from becoming an inventory of what a deployment chose to switch off.
 */
import { NextResponse } from 'next/server';
import { isModuleEnabled, type ModuleId } from '@/core/module-registry';

export function requireModule(id: ModuleId): NextResponse | null {
  if (isModuleEnabled(id)) return null;
  return NextResponse.json({ error: `Module "${id}" is not enabled in this deployment.` }, { status: 404 });
}
