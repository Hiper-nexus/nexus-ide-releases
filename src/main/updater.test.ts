import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
      removeListener: vi.fn(),
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

const managers: UpdateManager[] = [];
function createManager(...args: ConstructorParameters<typeof UpdateManager>): UpdateManager {
  const manager = new UpdateManager(...args);
  managers.push(manager);
  return manager;
}

beforeEach(() => {
  vi.stubEnv('NEXUS_UPDATE_FEED', undefined);
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('public network is not configured by this updater fixture'); }));
});

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

afterEach(async () => {
  for (const manager of managers.splice(0)) await manager.stop();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  electron.handlers.clear();
  vi.clearAllMocks();
  electron.app.isPackaged = true;
  rmSync(electron.logsPath, { recursive: true, force: true });
});

describe('UpdateManager', () => {
  it('uses the official feed for an installed packaged Windows x64 app', () => {
    const manager = createManager(true, {
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
    const manager = createManager(true, {
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

  it('keeps a packaged smoke test quiet instead of calling it a broken Squirrel install', () => {
    const manager = createManager(false, {
      runtimeArch: 'x64',
      runtimePlatform: 'win32',
      runtimeArgs: ['nexus-smoke-test'],
      appExecutablePath: 'C:\\build\\NexusIDE-win32-x64\\nexus-ide.exe',
      pathExists: () => false,
    });

    manager.init();

    expect(manager.getState()).toMatchObject({
      phase: 'unsupported',
      source: 'none',
      canInstall: false,
      error: undefined,
    });
    expect(electron.autoUpdater.setFeedURL).not.toHaveBeenCalled();
  });

  it('keeps the macOS initial check at three seconds', () => {
    vi.useFakeTimers();
    const previousFeed = process.env.NEXUS_UPDATE_FEED;
    process.env.NEXUS_UPDATE_FEED = 'https://api.nexuside.app/feed';
    try {
      const manager = createManager(true, {
        runtimeArch: 'arm64',
        runtimePlatform: 'darwin',
      });
      manager.init();

      vi.advanceTimersByTime(2_999);
      expect(electron.autoUpdater.checkForUpdates).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(electron.autoUpdater.checkForUpdates).toHaveBeenCalledTimes(1);
    } finally {
      if (previousFeed === undefined) delete process.env.NEXUS_UPDATE_FEED;
      else process.env.NEXUS_UPDATE_FEED = previousFeed;
    }
  });

  it.each([
    ['portable Windows package', true, 'x64', false],
    ['unsupported Windows architecture', true, 'arm64', true],
    ['Windows development build', false, 'x64', true],
  ])('fails clearly for %s', (_name, isPackaged, runtimeArch, updateExeExists) => {
    electron.app.isPackaged = isPackaged;
    const manager = createManager(true, {
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
    let rejectFirstDownload!: (error: Error) => void;
    const firstDownload = new Promise<never>((_resolve, reject) => { rejectFirstDownload = reject; });
    const fetchMock = vi.fn()
      .mockRejectedValue(new Error('public download unavailable in fixture'))
      .mockImplementationOnce(() => firstDownload);
    vi.stubGlobal('fetch', fetchMock);
    let releases = [apiRelease('0.16.1')];
    const runGh = vi.fn(async (args: string[], _timeoutMs: number) => {
      if (args[0] === 'api') return JSON.stringify(releases);
      throw new Error('download interrompido pelo teste');
    });
    const manager = createManager(true, {
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
    let installSettled = false;
    const installing = Promise.resolve(install?.(trustedSenderEvent())).finally(() => { installSettled = true; });
    try {
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
      expect(fetchMock.mock.calls[0]?.[0]).toContain('/v0.16.4/NexusIDE-darwin-arm64-0.16.4.zip');
      expect(manager.getState()).toMatchObject({ phase: 'downloading', available: { version: '0.16.4' } });
      // runGh alone cannot control installation: the public request runs first.
      expect(installSettled).toBe(false);
      expect(runGh.mock.calls.some(([args]) => args[0] === 'release')).toBe(false);
    } finally {
      rejectFirstDownload(new Error('release the controlled public download'));
      await installing;
    }

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
    const manager = createManager(true, {
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

  describe('Linux manual channel (F-751)', () => {
    const linuxRelease = (version: string) => ({
      tag_name: `v${version}`,
      published_at: '2026-10-02T15:00:19Z',
      draft: false,
      prerelease: false,
      body: 'notas',
      assets: [
        { name: `nexus-ide_${version}_amd64.deb` },
        { name: `nexus-ide-${version}-1.x86_64.rpm` },
        { name: `NexusIDE-linux-x64-${version}.zip` },
      ],
    });
    const stubReleases = (releases: unknown[]) => {
      const fetchMock = vi.fn(async (url: string) => ({
        ok: true,
        status: 200,
        text: async () => {
          expect(String(url)).toContain('Hiper-nexus/nexus-ide-releases');
          return JSON.stringify(releases);
        },
      }));
      vi.stubGlobal('fetch', fetchMock);
      return fetchMock;
    };
    const linuxManager = (runGh = vi.fn()) =>
      createManager(true, { runGh, runtimeArch: 'x64', runtimePlatform: 'linux' });

    it('boots as a manual channel instead of an unsupported platform error', () => {
      const manager = linuxManager();
      manager.init();
      expect(manager.getState()).toMatchObject({
        phase: 'idle',
        source: 'manual',
        canInstall: false,
        manual: {
          command: 'curl -fsSL https://nexuside.app/install-repo.sh | sh',
          downloadUrl: 'https://nexuside.app/#download',
        },
      });
      expect(manager.getState().error).toBeUndefined();
      expect(electron.autoUpdater.setFeedURL).not.toHaveBeenCalled();
    });

    it('announces a newer Linux release from the public mirror, without gh and without installing', async () => {
      const runGh = vi.fn();
      const fetchMock = stubReleases([linuxRelease('0.15.2'), apiRelease('0.15.9')]);
      const manager = linuxManager(runGh);
      manager.init();

      await electron.handlers.get(UPDATE_CHANNELS.check)?.(trustedSenderEvent());

      expect(manager.getState()).toMatchObject({
        phase: 'available',
        source: 'manual',
        canInstall: false,
        available: { version: '0.15.2', tag: 'v0.15.2' },
      });
      expect(fetchMock).toHaveBeenCalledOnce();
      expect(runGh).not.toHaveBeenCalled();

      // "Instalar" não baixa nem troca nada no Linux: o estado não muda.
      await electron.handlers.get(UPDATE_CHANNELS.install)?.(trustedSenderEvent());
      expect(manager.getState().phase).toBe('available');
      expect(manager.getState().error).toBeUndefined();
      expect(fetchMock).toHaveBeenCalledOnce();
    });

    it('is up to date when only other platforms have newer builds', async () => {
      stubReleases([apiRelease('0.15.9'), linuxRelease('0.15.0')]);
      const manager = linuxManager();
      manager.init();
      await electron.handlers.get(UPDATE_CHANNELS.check)?.(trustedSenderEvent());
      expect(manager.getState()).toMatchObject({ phase: 'uptodate', source: 'manual' });
      expect(manager.getState().available).toBeUndefined();
      expect(manager.getState().checkedAt).toBeTypeOf('number');
    });

    it('reports a failed check and keeps the manual instructions', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 503, text: async () => '' })));
      const manager = linuxManager();
      manager.init();
      await electron.handlers.get(UPDATE_CHANNELS.check)?.(trustedSenderEvent());
      expect(manager.getState().phase).toBe('error');
      expect(manager.getState().error).toContain('checagem falhou');
      expect(manager.getState().manual?.command).toContain('install-repo.sh');
    });

    it('keeps other non-updating platforms and Linux arm64 on the unsupported path', () => {
      const manager = createManager(true, { runtimeArch: 'arm64', runtimePlatform: 'linux' });
      manager.init();
      expect(manager.getState()).toMatchObject({ phase: 'unsupported', source: 'none' });
      expect(manager.getState().manual).toBeUndefined();
    });
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
    const manager = createManager(true, {
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
    const manager = createManager(true, {
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
      const manager = createManager(true, {
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
      if (prevFeed === undefined) delete process.env.NEXUS_UPDATE_FEED;
      else process.env.NEXUS_UPDATE_FEED = prevFeed;
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
      const manager = createManager(true, {
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
      if (prevFeed === undefined) delete process.env.NEXUS_UPDATE_FEED;
      else process.env.NEXUS_UPDATE_FEED = prevFeed;
    }
  });
});

describe('Linux self-update (pacote portátil)', () => {
  const linuxRelease = (version: string) => ({
    tag_name: `v${version}`,
    published_at: '2026-10-05T15:00:19Z',
    draft: false,
    prerelease: false,
    body: 'notas',
    assets: [
      { name: `nexus-ide_${version}_amd64.deb` },
      { name: `nexus-ide-${version}-1.x86_64.rpm` },
      { name: `NexusIDE-linux-x64-${version}.zip` },
    ],
  });
  const stubReleases = (releases: unknown[]) =>
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, status: 200, text: async () => JSON.stringify(releases) })),
    );
  const portable = { kind: 'portable', installDir: '/home/ana/.local/share/nexus-ide', parentDir: '/home/ana/.local/share' } as const;
  const make = (overrides: Record<string, unknown> = {}) => {
    const stage = vi.fn(async (input: { deps: { onProgress?: (a: number, b?: number) => void } }) => {
      input.deps.onProgress?.(10 * 1024 * 1024, 100 * 1024 * 1024);
      return { version: '0.15.2', stagedDir: `${portable.installDir}.new`, keyId: 'abc' };
    });
    const launch = vi.fn();
    const quit = vi.fn();
    const manager = createManager(true, {
      runGh: vi.fn(),
      runtimeArch: 'x64',
      runtimePlatform: 'linux',
      linuxSelfUpdate: { detect: () => portable, stage: stage as never, launch, quit, ...overrides },
    });
    return { manager, stage, launch, quit };
  };

  it('instalação portátil nasce com auto-update (canInstall, sem aviso manual)', () => {
    const { manager } = make();
    manager.init();
    expect(manager.getState()).toMatchObject({ phase: 'idle', canInstall: true, source: 'gh' });
    expect(manager.getState().manual).toBeUndefined();
  });

  it('DEB/RPM (instalação de sistema) continua no canal manual', () => {
    const { manager } = make({ detect: () => ({ kind: 'system', reason: 'instalado pelo gerenciador de pacotes' }) });
    manager.init();
    expect(manager.getState()).toMatchObject({ source: 'manual', canInstall: false });
    expect(manager.getState().manual?.command).toContain('install-repo.sh');
  });

  it('avisa, baixa com progresso, fica pronto e reinicia aplicando a troca', async () => {
    stubReleases([linuxRelease('0.15.2')]);
    const { manager, stage, launch, quit } = make();
    manager.init();
    await electron.handlers.get(UPDATE_CHANNELS.check)?.(trustedSenderEvent());
    expect(manager.getState()).toMatchObject({ phase: 'available', available: { version: '0.15.2', tag: 'v0.15.2' } });

    await electron.handlers.get(UPDATE_CHANNELS.install)?.(trustedSenderEvent());
    expect(stage).toHaveBeenCalledOnce();
    expect(stage.mock.calls[0][0]).toMatchObject({
      currentVersion: manager.getState().currentVersion,
      release: { version: '0.15.2', tag: 'v0.15.2' },
    });
    expect(manager.getState()).toMatchObject({ phase: 'ready' });
    expect(manager.getState().error).toBeUndefined();

    // O reinício só é aplicado depois que a pasta nova existe no disco.
    await electron.handlers.get(UPDATE_CHANNELS.restart)?.(trustedSenderEvent());
    expect(launch).not.toHaveBeenCalled();
    expect(manager.getState().phase).toBe('error');
    expect(manager.getState().error).toContain('install.sh');
    expect(quit).not.toHaveBeenCalled();
  });

  it('reinicia de verdade quando a pasta nova existe: lança o script e sai', async () => {
    stubReleases([linuxRelease('0.15.2')]);
    const dir = mkdtempSync(path.join(os.tmpdir(), 'updater-linux-'));
    try {
      mkdirSync(path.join(`${dir}/nexus-ide.new`), { recursive: true });
      writeFileSync(path.join(`${dir}/nexus-ide.new`, 'nexus-ide'), 'x');
      const install = { kind: 'portable', installDir: `${dir}/nexus-ide`, parentDir: dir } as const;
      const { manager, launch, quit } = make({
        detect: () => install,
        stage: vi.fn(async () => ({ version: '0.15.2', stagedDir: `${dir}/nexus-ide.new`, keyId: 'abc' })),
      });
      manager.init();
      await electron.handlers.get(UPDATE_CHANNELS.check)?.(trustedSenderEvent());
      await electron.handlers.get(UPDATE_CHANNELS.install)?.(trustedSenderEvent());
      expect(manager.getState().phase).toBe('ready');
      await electron.handlers.get(UPDATE_CHANNELS.restart)?.(trustedSenderEvent());
      expect(launch).toHaveBeenCalledOnce();
      expect(launch.mock.calls[0][0]).toMatchObject({ pid: process.pid, install });
      expect(quit).toHaveBeenCalledOnce();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('recusa de assinatura vira erro com o comando manual e nada é aplicado', async () => {
    stubReleases([linuxRelease('0.15.2')]);
    const { UpdateRefused } = await import('./linux-self-update');
    const { manager, launch, quit } = make({
      stage: vi.fn(async () => {
        throw new UpdateRefused('assinatura das somas inválida ou ZIP fora da lista');
      }),
    });
    manager.init();
    await electron.handlers.get(UPDATE_CHANNELS.check)?.(trustedSenderEvent());
    await electron.handlers.get(UPDATE_CHANNELS.install)?.(trustedSenderEvent());
    const state = manager.getState();
    expect(state.phase).toBe('error');
    expect(state.error).toContain('atualização recusada');
    expect(state.error).toContain('install.sh');
    await electron.handlers.get(UPDATE_CHANNELS.restart)?.(trustedSenderEvent());
    expect(launch).not.toHaveBeenCalled();
    expect(quit).not.toHaveBeenCalled();
  });

  it('falha de rede no download também devolve o comando manual', async () => {
    stubReleases([linuxRelease('0.15.2')]);
    const { manager } = make({ stage: vi.fn(async () => { throw new Error('download público: HTTP 503'); }) });
    manager.init();
    await electron.handlers.get(UPDATE_CHANNELS.check)?.(trustedSenderEvent());
    await electron.handlers.get(UPDATE_CHANNELS.install)?.(trustedSenderEvent());
    expect(manager.getState().error).toContain('download falhou');
    expect(manager.getState().error).toContain('install.sh');
  });

  it('já em dia: instalar não baixa nada', async () => {
    stubReleases([apiRelease('0.15.9')]);
    const { manager, stage } = make();
    manager.init();
    await electron.handlers.get(UPDATE_CHANNELS.check)?.(trustedSenderEvent());
    expect(manager.getState().phase).toBe('uptodate');
    await electron.handlers.get(UPDATE_CHANNELS.install)?.(trustedSenderEvent());
    expect(stage).not.toHaveBeenCalled();
  });
});
