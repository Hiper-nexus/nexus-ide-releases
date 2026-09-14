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
      // F-517 registrou rechecagem de update no foco da janela; o mock nunca
      // acompanhou e todos os testes do UpdateManager morriam em app.on.
      on: vi.fn(),
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
  vi.unstubAllGlobals();
  electron.handlers.clear();
  vi.clearAllMocks();
  electron.app.isPackaged = true;
  rmSync(electron.logsPath, { recursive: true, force: true });
});

describe('UpdateManager', () => {
  it('uses the official feed for an installed packaged Windows x64 app', () => {
    const manager = new UpdateManager(true, {
      runtimeArch: 'x64',
      runtimePlatform: 'win32',
      runtimeArgs: [],
      appExecutablePath: 'C:\\Users\\operator\\AppData\\Local\\NexusIDE\\app-0.15.0\\nexus-ide.exe',
      pathExists: (candidate) => candidate.endsWith('NexusIDE\\Update.exe'),
    });

    manager.init();

    expect(electron.autoUpdater.setFeedURL).toHaveBeenCalledWith({
      url: 'https://update.electronjs.org/Hiper-nexus/nexus-ide-releases/win32-x64/0.15.0',
    });
    expect(manager.getState()).toMatchObject({
      phase: 'idle',
      source: 'feed',
      canInstall: true,
    });
  });

  it('gates timer, focus and direct checks until the Windows first-run deadline', async () => {
    vi.useFakeTimers();
    const manager = new UpdateManager(true, {
      runtimeArch: 'x64',
      runtimePlatform: 'win32',
      runtimeArgs: ['--squirrel-firstrun'],
      appExecutablePath: 'C:\\NexusIDE\\app-0.15.0\\nexus-ide.exe',
      pathExists: () => true,
    });
    manager.init();
    const check = electron.handlers.get(UPDATE_CHANNELS.check);
    const onFocus = electron.app.on.mock.calls.find(
      ([event]) => event === 'browser-window-focus',
    )?.[1] as (() => void) | undefined;

    await check?.(trustedSenderEvent());
    onFocus?.();

    await vi.advanceTimersByTimeAsync(9_999);
    expect(electron.autoUpdater.checkForUpdates).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(electron.autoUpdater.checkForUpdates).toHaveBeenCalledTimes(1);
  });

  it('keeps the macOS initial check at three seconds', () => {
    vi.useFakeTimers();
    const previousFeed = process.env.NEXUS_UPDATE_FEED;
    process.env.NEXUS_UPDATE_FEED = 'https://api.nexuside.app/feed';
    try {
      const manager = new UpdateManager(true, {
        runtimeArch: 'arm64',
        runtimePlatform: 'darwin',
      });
      manager.init();

      vi.advanceTimersByTime(2_999);
      expect(electron.autoUpdater.checkForUpdates).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(electron.autoUpdater.checkForUpdates).toHaveBeenCalledTimes(1);
    } finally {
      process.env.NEXUS_UPDATE_FEED = previousFeed;
    }
  });

  it.each([
    ['portable Windows package', true, 'x64', false],
    ['unsupported Windows architecture', true, 'arm64', true],
    ['Windows development build', false, 'x64', true],
  ])('fails clearly for %s', (_name, isPackaged, runtimeArch, updateExeExists) => {
    electron.app.isPackaged = isPackaged;
    const manager = new UpdateManager(true, {
      runtimeArch,
      runtimePlatform: 'win32',
      runtimeArgs: [],
      appExecutablePath: 'C:\\NexusIDE\\app-0.15.0\\nexus-ide.exe',
      pathExists: () => updateExeExists,
    });

    manager.init();

    expect(manager.getState().phase).toBe('unsupported');
    expect(manager.getState().canInstall).toBe(false);
    expect(manager.getState().error).toBeTruthy();
    expect(electron.autoUpdater.setFeedURL).not.toHaveBeenCalled();
  });

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
    expect(downloadArgs).toContain('Hiper-nexus/nexus-ide');
    expect(downloadArgs).not.toContain('v0.16.1');
  });

  it('cai no slug legado quando o gh da org nova falha', async () => {
    const runGh = vi.fn(async (args: string[]) => {
      if (args.join(' ').includes('Hiper-nexus/nexus-ide')) {
        throw new Error('HTTP 404');
      }
      if (args[0] === 'api') return JSON.stringify([apiRelease('0.32.16')]);
      throw new Error('download interrompido pelo teste');
    });
    const manager = new UpdateManager(true, {
      runGh,
      runtimeArch: 'arm64',
      runtimePlatform: 'darwin',
    });
    manager.init();
    const check = electron.handlers.get(UPDATE_CHANNELS.check);
    await check?.(trustedSenderEvent());
    expect(manager.getState().available?.version).toBe('0.32.16');
    const apiRepos = runGh.mock.calls
      .filter(([args]) => args[0] === 'api')
      .map(([args]) => args.join(' '));
    expect(apiRepos[0]).toContain('Hiper-nexus/nexus-ide');
    expect(apiRepos[1]).toContain('cleofasvolarehost/nexus-ide');
  });

  it('usa o espelho público da org nova quando gh não está disponível', async () => {
    const runGh = vi.fn(async () => {
      throw new Error('ENOENT gh');
    });
    const fetchMock = vi.fn(async (url: string) => ({
      ok: true,
      status: 200,
      text: async () => {
        expect(String(url)).toContain('Hiper-nexus/nexus-ide-releases');
        return JSON.stringify([apiRelease('0.32.16')]);
      },
    }));
    vi.stubGlobal('fetch', fetchMock);
    const manager = new UpdateManager(true, {
      runGh,
      runtimeArch: 'arm64',
      runtimePlatform: 'darwin',
    });
    manager.init();
    const check = electron.handlers.get(UPDATE_CHANNELS.check);
    await check?.(trustedSenderEvent());
    expect(manager.getState().phase).toBe('available');
    expect(manager.getState().available?.version).toBe('0.32.16');
    expect(fetchMock).toHaveBeenCalled();
  });

  it('segue o 301 JSON do slug legado até o Latest da org nova', async () => {
    const runGh = vi.fn(async () => {
      throw new Error('HTTP 404');
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 301,
        text: async () =>
          JSON.stringify({
            message: 'Moved Permanently',
            url: 'https://api.github.com/repositories/1304178302/releases?per_page=100',
          }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => JSON.stringify([apiRelease('0.32.16')]),
      });
    vi.stubGlobal('fetch', fetchMock);
    const manager = new UpdateManager(true, {
      runGh,
      runtimeArch: 'arm64',
      runtimePlatform: 'darwin',
    });
    manager.init();
    const check = electron.handlers.get(UPDATE_CHANNELS.check);
    await check?.(trustedSenderEvent());
    expect(manager.getState().available?.version).toBe('0.32.16');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain(
      'repositories/1304178302',
    );
  });

  it('mapeia erro de assinatura de código do Squirrel para orientação amigável em português', () => {
    const listeners = new Map<string, (err: unknown) => void>();
    electron.autoUpdater.on.mockImplementation((event: string, cb: (err: unknown) => void) => {
      listeners.set(event, cb);
      return electron.autoUpdater;
    });
    const prevFeed = process.env.NEXUS_UPDATE_FEED;
    process.env.NEXUS_UPDATE_FEED = 'https://api.nexuside.app/feed';
    try {
      const manager = new UpdateManager(true, {
        runtimeArch: 'arm64',
        runtimePlatform: 'darwin',
      });
      manager.init();
      const errorHandler = listeners.get('error');
      expect(errorHandler).toBeDefined();
      errorHandler?.(new Error('Could not get code signature for running application'));
      expect(manager.getState().phase).toBe('error');
      expect(manager.getState().error).toBe(
        'O app atual foi aberto fora de /Applications ou a partir de build sem assinatura Developer ID. Instale o .dmg oficial para atualizar.',
      );
    } finally {
      process.env.NEXUS_UPDATE_FEED = prevFeed;
    }
  });

  it('trata feed Windows ausente como nenhuma atualização publicada', () => {
    const listeners = new Map<string, (err: unknown) => void>();
    electron.autoUpdater.on.mockImplementation((event: string, cb: (err: unknown) => void) => {
      listeners.set(event, cb);
      return electron.autoUpdater;
    });
    const prevFeed = process.env.NEXUS_UPDATE_FEED;
    process.env.NEXUS_UPDATE_FEED = 'https://update.electronjs.org/Hiper-nexus/nexus-ide-releases/win32-x64/0.15.0';
    try {
      const manager = new UpdateManager(true, {
        runtimeArch: 'x64',
        runtimePlatform: 'win32',
        runtimeArgs: [],
        appExecutablePath: 'C:\\NexusIDE\\app-0.15.0\\nexus-ide.exe',
        pathExists: () => true,
      });
      manager.init();
      listeners.get('error')?.(new Error('Unexpected response code: 404'));
      expect(manager.getState()).toMatchObject({
        phase: 'uptodate',
        error: undefined,
      });
      expect(manager.getState().checkedAt).toEqual(expect.any(Number));
    } finally {
      process.env.NEXUS_UPDATE_FEED = prevFeed;
    }
  });
});
