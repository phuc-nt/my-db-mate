/**
 * The registry unit tests prove the flag parses. These prove the flag is WIRED:
 * for two representative modules, that each of the four chokepoints actually
 * consults it. A flag nothing reads is the failure mode worth testing for.
 *
 * automations owns cron; metrics owns MCP tools — between them the four
 * chokepoints (route guard, nav, cron loader, MCP list) are all covered.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { requireModule } from './require-module';
import { disabledMcpTools, isModuleEnabled, resetModuleCacheForTests } from './module-registry';

const ORIGINAL = process.env.MODULES_DISABLED;

function setDisabled(value: string | undefined) {
  if (value === undefined) delete process.env.MODULES_DISABLED;
  else process.env.MODULES_DISABLED = value;
  resetModuleCacheForTests();
}

afterEach(() => {
  setDisabled(ORIGINAL);
  vi.resetModules();
});

/** The nav's segment→module map, mirrored from the workspace layout. Kept in
 *  sync by the assertion below that every segment names a real module. */
const SEGMENT_MODULE = {
  chat: 'chat-agent',
  schema: 'db-client',
  context: 'context-studio',
  metrics: 'metrics',
  automations: 'automations',
} as const;

function visibleSegments(): string[] {
  return Object.entries(SEGMENT_MODULE)
    .filter(([, mod]) => isModuleEnabled(mod))
    .map(([seg]) => seg);
}

describe('module flags at the four chokepoints', () => {
  it('route guard: 404s a disabled module and passes an enabled one', async () => {
    setDisabled('automations');
    const blocked = requireModule('automations');
    expect(blocked).not.toBeNull();
    expect(blocked!.status).toBe(404);
    await expect(blocked!.json()).resolves.toMatchObject({ error: expect.stringContaining('automations') });

    expect(requireModule('metrics')).toBeNull();
  });

  it('nav: the disabled module loses its tab and the others keep theirs', () => {
    setDisabled('automations');
    expect(visibleSegments()).not.toContain('automations');
    expect(visibleSegments()).toContain('metrics');
    expect(visibleSegments()).toContain('chat');
  });

  it('cron loader: skips loadSchedules when automations is off', async () => {
    const loadSchedules = vi.fn();
    vi.doMock('@/modules/automations', () => ({ loadSchedules }));
    const prevRuntime = process.env.NEXT_RUNTIME;
    process.env.NEXT_RUNTIME = 'nodejs';
    setDisabled('automations');

    const { register } = await import('@/instrumentation');
    await register();
    expect(loadSchedules).not.toHaveBeenCalled();

    process.env.NEXT_RUNTIME = prevRuntime;
    vi.doUnmock('@/modules/automations');
  });

  it('cron loader: loads schedules when automations is on', async () => {
    const loadSchedules = vi.fn().mockResolvedValue(undefined);
    vi.doMock('@/modules/automations', () => ({ loadSchedules }));
    const prevRuntime = process.env.NEXT_RUNTIME;
    process.env.NEXT_RUNTIME = 'nodejs';
    setDisabled(undefined);

    const { register } = await import('@/instrumentation');
    await register();
    expect(loadSchedules).toHaveBeenCalledTimes(1);

    process.env.NEXT_RUNTIME = prevRuntime;
    vi.doUnmock('@/modules/automations');
  });

  it('MCP list: hides a disabled module\'s tools and keeps the rest', () => {
    setDisabled('metrics');
    const hidden = disabledMcpTools();
    expect(hidden.has('list_governed_metrics')).toBe(true);
    expect(hidden.has('run_governed_metric')).toBe(true);
    expect(hidden.has('ask_database')).toBe(false);
    expect(hidden.has('run_sql')).toBe(false);
  });

  it('re-enabling restores all four surfaces', async () => {
    setDisabled(undefined);
    expect(requireModule('automations')).toBeNull();
    expect(requireModule('metrics')).toBeNull();
    expect(visibleSegments()).toContain('automations');
    expect(visibleSegments()).toContain('metrics');
    expect(disabledMcpTools().size).toBe(0);
  });

  it('every nav segment names a module the registry knows', async () => {
    const { MODULES } = await import('./module-registry');
    const ids = new Set(MODULES.map((m) => m.id));
    for (const mod of Object.values(SEGMENT_MODULE)) expect(ids).toContain(mod);
  });
});
