/**
 * Which feature modules are switched on for this deployment.
 *
 * "Installable modules" without a plugin loader: the same binary ships every
 * module and `MODULES_DISABLED` decides which ones exist at runtime. That keeps
 * the build reproducible and the boundary honest — a module you can turn off is
 * a module whose edges you actually know.
 *
 * Env, not the settings UI, on purpose. Module availability is deployment
 * config: an agent that can be talked into enabling a module through a settings
 * write is an agent that can widen its own blast radius, and a prompt-injected
 * one will try. `process.env` is not reachable that way.
 *
 * Core is absent from this list by design. There is no meaningful build of this
 * product without a connection layer, a safety layer, and an executor, so
 * offering a switch for them would only be a way to configure a broken install.
 */

export type ModuleId =
  | 'chat-agent'
  | 'context-studio'
  | 'metrics'
  | 'bi'
  | 'automations'
  | 'anomaly'
  | 'db-client'
  | 'notebooks'
  | 'datamart'
  | 'mcp'
  | 'demo'
  | 'eval'
  | 'onboarding';

export interface ModuleSpec {
  id: ModuleId;
  /** Label in the workspace rail / global nav, when the module has a tab. */
  navLabel?: string;
  /** Route prefixes this module owns. Used by the route guard and to reason
   *  about what disappears when the module is off. */
  routes: string[];
  /** True when this module registers cron tasks at boot. */
  cronOwner?: boolean;
  /** MCP tool names this module contributes, filtered out when it is off. */
  mcpTools?: string[];
  /** Shown when someone disables a module with a surprising consequence. */
  warning?: string;
}

export const MODULES: readonly ModuleSpec[] = [
  {
    id: 'chat-agent',
    navLabel: '💬 Chat',
    routes: ['/api/chat', '/db/:id/chat'],
    mcpTools: ['ask_database'],
    warning: 'Disabling chat leaves a plain DB client: browse, dashboards and metrics still work, but nothing answers questions.',
  },
  { id: 'context-studio', navLabel: '📚 Context', routes: ['/api/connections/:id/context', '/context-studio', '/db/:id/context'], mcpTools: ['get_schema_context', 'search_verified_queries'] },
  { id: 'metrics', navLabel: '📈 Metrics', routes: ['/api/connections/:id/metrics', '/db/:id/metrics'], mcpTools: ['list_governed_metrics', 'run_governed_metric'] },
  { id: 'bi', navLabel: 'Dashboards', routes: ['/api/dashboards', '/api/reports', '/dashboards', '/reports'] },
  { id: 'automations', navLabel: '⏰ Automations', routes: ['/api/connections/:id/schedules', '/api/connections/:id/triggers', '/db/:id/automations'], cronOwner: true },
  { id: 'anomaly', routes: ['/api/connections/:id/anomaly', '/api/connections/:id/data-quality'] },
  { id: 'db-client', navLabel: '🗂 Schema', routes: ['/browse', '/db/:id/schema'] },
  { id: 'notebooks', navLabel: 'Notebooks', routes: ['/api/notebooks', '/notebooks'] },
  { id: 'datamart', routes: ['/api/connections/:id/datamart'] },
  { id: 'mcp', routes: [] },
  { id: 'demo', routes: ['/api/demo'] },
  { id: 'eval', routes: ['/api/connections/:id/eval', '/eval'] },
  { id: 'onboarding', routes: ['/api/onboarding'] },
] as const;

const BY_ID = new Map<string, ModuleSpec>(MODULES.map((m) => [m.id, m]));

/** Parse once per process. Module availability cannot change without a restart,
 *  which is the point: it is deployment config, not a runtime toggle. */
let cache: { raw: string | undefined; disabled: Set<string> } | null = null;

function disabledSet(): Set<string> {
  const raw = process.env.MODULES_DISABLED;
  if (cache && cache.raw === raw) return cache.disabled;
  const disabled = new Set<string>();
  for (const part of (raw ?? '').split(',')) {
    const id = part.trim();
    if (!id) continue;
    if (!BY_ID.has(id)) {
      // Warn rather than throw. A typo in a deploy env var should not take the
      // whole app down — the safe reading of an unknown name is "no module by
      // that name was disabled", which is what ignoring it does.
      console.warn(`[modules] MODULES_DISABLED lists unknown module "${id}" — ignored. Known: ${MODULES.map((m) => m.id).join(', ')}`);
      continue;
    }
    disabled.add(id);
  }
  cache = { raw, disabled };
  return disabled;
}

export function isModuleEnabled(id: ModuleId): boolean {
  return !disabledSet().has(id);
}

export function enabledModules(): ModuleSpec[] {
  return MODULES.filter((m) => isModuleEnabled(m.id));
}

/** MCP tool names to hide, derived from whichever modules are off. */
export function disabledMcpTools(): Set<string> {
  const out = new Set<string>();
  for (const m of MODULES) {
    if (isModuleEnabled(m.id)) continue;
    for (const t of m.mcpTools ?? []) out.add(t);
  }
  return out;
}

/** Warnings for modules that are off and whose absence is worth stating. */
export function disabledWarnings(): string[] {
  return MODULES.filter((m) => !isModuleEnabled(m.id) && m.warning).map((m) => `[modules] ${m.id} disabled — ${m.warning}`);
}

/** Test seam: drop the parse cache. Production never needs this (env is fixed
 *  for the life of the process), but a test that sets MODULES_DISABLED must be
 *  able to make the next read see it. */
export function resetModuleCacheForTests(): void {
  cache = null;
}
