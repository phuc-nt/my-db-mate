/**
 * Next.js server-boot hook. Without this, node-cron tasks only exist after a
 * schedule mutation in the current process — i.e. every restart silently killed
 * all schedules (found by red-team 260712: loadSchedules()'s own comment said
 * "call on boot" but nothing ever did).
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;

  const { isModuleEnabled, disabledWarnings } = await import('@/core/module-registry');
  for (const w of disabledWarnings()) console.warn(w);

  // Skipped, not errored: a deployment that turned automations off is not a
  // broken one, and the module's own import is avoided entirely so a disabled
  // module costs nothing at boot.
  if (!isModuleEnabled('automations')) {
    console.log('[boot] automations disabled — no schedules loaded');
    return;
  }
  const { loadSchedules } = await import('@/modules/automations');
  await loadSchedules().catch((e) => console.error('[boot] loadSchedules failed:', e));
}
