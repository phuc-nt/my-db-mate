/**
 * Automations (schedules, monitors, action triggers): public surface.
 *
 * Kept to what shipped code outside this module actually calls: the schedules and
 * action-triggers API routes, plus the Next.js boot hook that reloads cron tasks.
 *
 * The monitor finding/snapshot TYPES are deliberately not here — they live in
 * `@/core/lib/monitor-diff`, because chat-agent needs them too and importing this
 * barrel for a type closed a cycle through schedule-service -> agent-service.
 *
 * Notably NOT exported: `evaluateTriggers`, `matchesCondition`, `renderPayload`,
 * `captureSnapshot`. Those are the engine — firing a webhook or capturing a
 * snapshot must go through a schedule tick, not be driven from another module.
 * Its own tests reach them directly from inside the module, which is the point of
 * having a barrel at the edge rather than restricting the folder.
 */
export {
  loadSchedules,
  createSchedule,
  listSchedules,
  deleteSchedule,
  runSchedule,
  setScheduleEnabled,
} from './schedule-service';

export {
  listTriggers,
  listFiresForConnection,
  createTrigger,
  updateTrigger,
  deleteTrigger,
  testFire,
} from './action-trigger-service';
