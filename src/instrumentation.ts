/**
 * Next.js server-boot hook. Without this, node-cron tasks only exist after a
 * schedule mutation in the current process — i.e. every restart silently killed
 * all schedules (found by red-team 260712: loadSchedules()'s own comment said
 * "call on boot" but nothing ever did).
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { loadSchedules } = await import('./services/schedule-service');
    await loadSchedules().catch((e) => console.error('[boot] loadSchedules failed:', e));
  }
}
