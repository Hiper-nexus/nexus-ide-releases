import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { WINDOW_CHANNELS } from '../shared/channels';
import { FUNCTIONAL_SMOKE_REQUIRED_PROBES, FUNCTIONAL_SMOKE_MIN_ADAPTERS, FUNCTIONAL_SMOKE_MIN_TOOLS } from '../shared/smoke-types';

const seam = vi.hoisted(() => ({ userData: '', windowCreated: null as ((e: unknown, win: unknown) => void) | null,
  quit: vi.fn(), ipc: new Map<string, (event: unknown, raw: unknown) => void>() }));
vi.mock('electron', () => ({ app: { isPackaged: true, getPath: () => seam.userData, getVersion: () => '0.76.192',
  quit: seam.quit, on: (event: string, listener: never) => { if (event === 'browser-window-created') seam.windowCreated = listener; } },
  ipcMain: { on: (channel: string, listener: never) => seam.ipc.set(channel, listener),
    removeListener: (channel: string) => seam.ipc.delete(channel) } }));
vi.mock('./smoke-core', async () => ({ ...await vi.importActual('./smoke-core'), isCurrentProcessSmokeTest: () => true }));
vi.mock('./pty/pty-host-client', () => ({ createRealPtyHost: () => ({}) }));
vi.mock('./pty/darwin-pty-smoke', () => ({ proveDarwinPtyPipelineForSmoke: async () => false }));
vi.mock('./hang-watchdog/smoke-busy-banner', () => ({ isSmokeBusyBannerProbeRequested: () => false, proveMountedBusyBannerForSmoke: async () => {} }));
vi.mock('./persistence/workspace-store', () => ({ grantWorkspacePathFromTrustedMain: (_wc: unknown, value: string) => value }));

it.each(['uncaught-exception', 'timeout'])('real smoke caller arms FAIL physical quit during preflight IO for %s', async kind => {
  vi.resetModules(); seam.quit.mockClear(); seam.ipc.clear();
  const priorExitCode = process.exitCode;
  const initialHandlers = new Set(process.listeners('uncaughtException'));
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'nexus-soak-review-preflight-')));
  seam.userData = root;
  await fs.mkdir(path.join(root, 'home'), { mode: 0o700 });
  vi.stubEnv('NEXUS_PACKAGED_SMOKE', '1'); vi.stubEnv('NEXUS_USER_DATA_DIR', root);
  vi.stubEnv('HOME', path.join(root, 'home')); vi.stubEnv('NEXUS_SMOKE_SOAK', '1');
  let release!: () => void, began!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const observed = new Promise<void>(resolve => { began = resolve; });
  const originalLstat = fs.lstat.bind(fs);
  const lstat = vi.spyOn(fs, 'lstat').mockImplementationOnce(async (...args) => {
    began(); await gate; return originalLstat(...args);
  });
  const timerSpy = vi.spyOn(globalThis, 'setTimeout');
  let timerHandle: ReturnType<typeof setTimeout> | undefined;
  try {
    const { initSmokeTest } = await import('./smoke-test');
    initSmokeTest();
    const frame = {}, wc = Object.assign(new EventEmitter(), { mainFrame: frame, getOSProcessId: () => 1234, send: vi.fn() });
    const win = Object.assign(new EventEmitter(), { webContents: wc });
    seam.windowCreated!(null, win);
    seam.ipc.get(WINDOW_CHANNELS.functionalSmokeResult)!({ sender: wc, senderFrame: frame }, {
      ok: true, probes: [...FUNCTIONAL_SMOKE_REQUIRED_PROBES], adapterCount: FUNCTIONAL_SMOKE_MIN_ADAPTERS, toolCount: FUNCTIONAL_SMOKE_MIN_TOOLS,
    });
    await observed;
    const timeoutIndex = timerSpy.mock.calls.findIndex(call => call[1] === 480000);
    expect(timeoutIndex).toBeGreaterThanOrEqual(0);
    timerHandle = timerSpy.mock.results[timeoutIndex]!.value;
    if (kind === 'timeout') (timerSpy.mock.calls[timeoutIndex]![0] as () => void)();
    else {
      const handler = process.listeners('uncaughtException').find(listener => !initialHandlers.has(listener));
      expect(handler).toBeDefined(); handler!(new Error('private fixture crash'), 'uncaughtException');
    }
    // Real initSmokeTest and real proveSoakForSmoke are suspended in their
    // first physical filesystem read. An abort listener installed later cannot
    // be the authority for arming Main's existing quit ceiling now.
    expect(seam.quit).toHaveBeenCalledOnce();
    expect(process.exitCode).toBe(1);
  } finally {
    release(); lstat.mockRestore();
    // Node has no qualified Electron version: released real preflight rejects,
    // and the caller drains that same promise before fixture removal.
    await vi.waitFor(() => expect(seam.quit).toHaveBeenCalledOnce());
    for (const listener of process.listeners('uncaughtException')) if (!initialHandlers.has(listener)) process.removeListener('uncaughtException', listener);
    if (timerHandle) clearTimeout(timerHandle);
    timerSpy.mockRestore(); vi.unstubAllEnvs(); process.exitCode = priorExitCode;
    await fs.rm(root, { recursive: true, force: true });
  }
});
