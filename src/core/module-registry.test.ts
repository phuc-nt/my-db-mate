import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  isModuleEnabled,
  enabledModules,
  disabledMcpTools,
  disabledWarnings,
  resetModuleCacheForTests,
  MODULES,
} from './module-registry';

const ORIGINAL = process.env.MODULES_DISABLED;

function setDisabled(value: string | undefined) {
  if (value === undefined) delete process.env.MODULES_DISABLED;
  else process.env.MODULES_DISABLED = value;
  resetModuleCacheForTests();
}

describe('module registry', () => {
  beforeEach(() => setDisabled(undefined));
  afterEach(() => setDisabled(ORIGINAL));

  it('enables everything when the env var is unset', () => {
    expect(enabledModules()).toHaveLength(MODULES.length);
    expect(isModuleEnabled('notebooks')).toBe(true);
  });

  it('disables exactly the listed modules', () => {
    setDisabled('notebooks,metrics');
    expect(isModuleEnabled('notebooks')).toBe(false);
    expect(isModuleEnabled('metrics')).toBe(false);
    expect(isModuleEnabled('bi')).toBe(true);
    expect(enabledModules()).toHaveLength(MODULES.length - 2);
  });

  it('tolerates whitespace and empty entries', () => {
    setDisabled(' notebooks , , metrics ');
    expect(isModuleEnabled('notebooks')).toBe(false);
    expect(isModuleEnabled('metrics')).toBe(false);
  });

  it('warns about an unknown id instead of crashing', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    setDisabled('notebooks,notarealmodule');
    // The real module in the same list still takes effect: one typo must not
    // silently discard the rest of the deploy's intent.
    expect(isModuleEnabled('notebooks')).toBe(false);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('notarealmodule'));
    warn.mockRestore();
  });

  it('hides only the MCP tools of disabled modules', () => {
    setDisabled('metrics');
    const hidden = disabledMcpTools();
    expect(hidden.has('list_governed_metrics')).toBe(true);
    expect(hidden.has('run_governed_metric')).toBe(true);
    // ask_database belongs to chat-agent, which is still on.
    expect(hidden.has('ask_database')).toBe(false);
  });

  it('surfaces a warning for a module whose absence changes what the app is', () => {
    setDisabled('chat-agent');
    expect(disabledWarnings().join(' ')).toContain('plain DB client');
  });

  it('re-reads when the env var changes', () => {
    setDisabled('notebooks');
    expect(isModuleEnabled('notebooks')).toBe(false);
    setDisabled(undefined);
    expect(isModuleEnabled('notebooks')).toBe(true);
  });

  it('notices an env change without being told to drop its cache', () => {
    // The other tests all call resetModuleCacheForTests, so they would pass even
    // if the cache never re-read the env at all. This one deliberately does not
    // reset: it is the only test that can see a stale cache, which is the actual
    // failure mode (a process reading a value that is no longer true).
    process.env.MODULES_DISABLED = 'notebooks';
    resetModuleCacheForTests();
    expect(isModuleEnabled('notebooks')).toBe(false);

    process.env.MODULES_DISABLED = 'metrics';
    expect(isModuleEnabled('notebooks')).toBe(true);
    expect(isModuleEnabled('metrics')).toBe(false);
  });

  it('gives every module a unique id', () => {
    const ids = MODULES.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
