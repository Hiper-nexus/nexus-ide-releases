import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { DictatedSessionInfo } from '../pty/pty-manager';
const deps = vi.hoisted(() => ({ root: '', hook: null as null | ((info: DictatedSessionInfo) => void),
  stops: new Map<string, Promise<void>>(), contexts: new Map<string, unknown>(), disposed: vi.fn(), record: vi.fn(),
  mimoStarts: 0,
  mimoEvent: null as null | ((...args: any[]) => void), mimoTap: null as null | ((...args: any[]) => void) }));
vi.mock('electron', () => ({ app: { getPath: () => deps.root }, BrowserWindow: { getAllWindows: () => [] },
  ipcMain: { removeHandler: vi.fn(), handle: vi.fn() } }));
vi.mock('../pty/pty-manager', () => ({ setSessionDictationHook: (fn: typeof deps.hook) => { deps.hook = fn; },
  setResumeSessionLookup: vi.fn(), setResumeSessionForget: vi.fn() }));
vi.mock('../orch/gate', () => ({ getContextBySession: (id: string) => deps.contexts.get(id), executionScopeFor: (ctx: any) => ctx.scope }));
vi.mock('./claude-transcript-watcher', () => ({ ClaudeTranscriptWatcher: class { start() {} rescan() {} stop() { return deps.stops.get('claude'); } } }));
vi.mock('./codex-scanner', () => ({ CodexUsageScanner: class { start() {} stop() { return deps.stops.get('codex'); } } }));
vi.mock('./mimo-scanner', () => ({ MimoUsageScanner: class {
  constructor(callback: typeof deps.mimoEvent) { deps.mimoEvent = callback; }
  start() { deps.mimoStarts++; } bind() {} remove() {} stop() { return deps.stops.get('mimo'); }
} }));
vi.mock('../agent-hooks/mimo-session-registry', () => ({ isMimoUsageBindingProved: () => true,
  resolveMimoUsageBinding: (binding: unknown) => binding,
  releaseMimoUsageBinding: () => {}, tapMimoSessionBindings: (callback: typeof deps.mimoTap) => {
  deps.mimoTap = callback; return () => { deps.mimoTap = null; };
} }));
vi.mock('../persistence/provider-session-store', () => ({ saveProviderPaneSession: () => true,
  getProviderPaneSession: () => null, forgetProviderSessionById: () => 0 }));
const registry = vi.hoisted(() => ({ forScope: () => ({ usage: { record: deps.record }, media: {} }) }));
vi.mock('./usage-store-registry', () => ({ configureProjectUsageStoreRegistry: () => registry,
  disposeProjectUsageStoreRegistry: deps.disposed }));
import { initUsageTelemetry, shutdownUsageTelemetry } from './usage-service';

const release = new Map<string, () => void>();
beforeEach(() => {
  deps.root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'usage-physical-stop-')));
  deps.disposed.mockClear(); deps.record.mockClear(); deps.contexts.clear(); release.clear();
  deps.mimoStarts = 0;
  for (const provider of ['claude', 'codex', 'mimo']) deps.stops.set(provider, new Promise<void>(resolve => release.set(provider, resolve)));
});

it('replacement waits for the old physical flight and shutdown cancels a pending replacement', async () => {
  await initUsageTelemetry({} as never);
  expect(deps.mimoStarts).toBe(1);
  const replacement = initUsageTelemetry({} as never);
  await Promise.resolve(); await Promise.resolve();
  expect(deps.mimoStarts).toBe(1);
  expect(deps.mimoTap).toBeNull();
  const shutdown = shutdownUsageTelemetry();
  release.get('mimo')!();
  expect(await replacement).toBeNull();
  await shutdown;
  expect(deps.mimoStarts).toBe(1);
});
afterEach(async () => {
  for (const resolve of release.values()) resolve();
  await shutdownUsageTelemetry(); fs.rmSync(deps.root, { recursive: true, force: true });
});

it('stops event admission first, waits for every physical scanner, then disposes stores', async () => {
  const service = await initUsageTelemetry({} as never);
  const scope = { version: 1, installationId: 'i', projectId: 'p', checkoutId: 'c',
    rootRealPath: deps.root, identitySource: 'manifest' };
  for (const provider of ['claude', 'codex']) {
    deps.contexts.set(provider, { scope });
    deps.hook!({ adapterId: provider, ptySessionId: provider, cwd: deps.root, paneId: provider,
      providerSessionId: `conversation-${provider}` } as DictatedSessionInfo);
  }
  const late = deps.mimoEvent!;
  let done = false;
  const shutdown = shutdownUsageTelemetry();
  Promise.resolve(shutdown).then(() => { done = true; });
  expect(deps.hook).toBeNull(); expect(deps.mimoTap).toBeNull();
  await Promise.resolve(); await Promise.resolve();
  expect(done).toBe(false); expect(deps.disposed).not.toHaveBeenCalled();
  expect(() => late({ scope }, {})).not.toThrow();
  expect(deps.record).not.toHaveBeenCalled();
  release.get('mimo')!(); release.get('claude')!(); await Promise.resolve();
  expect(done).toBe(false); expect(deps.disposed).not.toHaveBeenCalled();
  release.get('codex')!(); await shutdown;
  expect(deps.disposed).toHaveBeenCalledTimes(1);
  expect(service?.stop()).toBeInstanceOf(Promise);
});
