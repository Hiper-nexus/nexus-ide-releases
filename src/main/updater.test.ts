import { rmSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';

const electron = vi.hoisted(() => {
  const handlers = new Map<
    string,
    (event?: unknown, ...args: unknown[]) => Promise<unknown> | unknown
  >();
  const logsPath = `/tmp/nexus-updater-test-${process.pid}`;
  return {
    handlers,
    logsPath,
    app: {
      isPackaged: true,
      getVersion: () => '0.15.0',
      getPath: () => logsPath,
    },
    autoUpdater: {
      setFeedURL: vi.fn(),
      checkForUpdates: vi.fn(),
      quitAndInstall: vi.fn(),
      on: vi.fn(),
    },
    BrowserWindow: { getAllWindows: () => [] },
    dialog: { showMessageBox: vi.fn() },
    ipcMain: {
      handle: (
        channel: string,
        handler: (
          event?: unknown,
          ...args: unknown[]
        ) => Promise<unknown> | unknown,
      ) => {
        handlers.set(channel, handler);
      },
    },
  };
});

vi.mock('electron', () => ({
  app: electron.app,
  autoUpdater: electron.autoUpdater,
  BrowserWindow: electron.BrowserWindow,
  dialog: electron.dialog,
  ipcMain: electron.ipcMain,
}));

import { UPDATE_CHANNELS } from '../shared/update-ipc';
import { bindTrustedMainWindow } from './security/trusted-ipc';
import { UpdateManager } from './updater';

function trustedSenderEvent() {
  const contents = {
    mainFrame: { id: 1 },
    isDestroyed: () => false,
    isCrashed: () => false,
    getURL: () => 'nexus://app/index.html',
    once: () => undefined,
  };
  const win = {
    webContents: contents,
    isDestroyed: () => false,
  };
  bindTrustedMainWindow(win as never, 'nexus://app/index.html');
  return { sender: contents, senderFrame: contents.mainFrame };
}

function apiRelease(version: string) {
  return {
    tag_name: `v${version}`,
    published_at: '2026-07-15T20:00:00Z',
    draft: false,
    prerelease: false,
    assets: [{ name: `NexusIDE-darwin-arm64-${version}.zip` }],
  };
}

afterEach(() => {
  vi.useRealTimers();
  electron.handlers.clear();
  vi.clearAllMocks();
  rmSync(electron.logsPath, { recursive: true, force: true });
});

describe('UpdateManager', () => {
  it('revalida uma oferta antiga e baixa somente o release mais novo', async () => {
    vi.useFakeTimers();
    let releases = [apiRelease('0.16.1')];
    const runGh = vi.fn(async (args: string[], _timeoutMs: number) => {
      if (args[0] === 'api') return JSON.stringify(releases);
      throw new Error('download interrompido pelo teste');
    });
    const manager = new UpdateManager(true, {
      runGh,
      runtimeArch: 'arm64',
      runtimePlatform: 'darwin',
    });
    manager.init();

    const check = electron.handlers.get(UPDATE_CHANNELS.check);
    const install = electron.handlers.get(UPDATE_CHANNELS.install);
    expect(check).toBeTypeOf('function');
    expect(install).toBeTypeOf('function');

    await check?.(trustedSenderEvent());
    expect(manager.getState().available?.version).toBe('0.16.1');

    releases = [apiRelease('0.16.1'), apiRelease('0.16.4')];
    await install?.(trustedSenderEvent());

    const downloadArgs = runGh.mock.calls.find(
      ([args]) => args[0] === 'release' && args[1] === 'download',
    )?.[0];
    expect(downloadArgs).toContain('v0.16.4');
    expect(downloadArgs).not.toContain('v0.16.1');
  });
});
