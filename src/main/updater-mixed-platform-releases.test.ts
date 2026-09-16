import { rmSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * Cenário: campanha de release "Mac primeiro" (ver scripts/publish-windows-
 * release.mjs e nexus-release-process.md) — o release v0.76.42 já existe no
 * repo canônico com o zip do mac, mas os assets do Windows (Setup.exe/nupkg/
 * RELEASES) só chegam depois, anexados à mesma tag por uma máquina separada.
 * v0.76.40/v0.76.41 já têm os dois lados completos. Esta é a lista mista que
 * chega tanto ao cliente mac quanto — via mecanismo totalmente diferente —
 * ao cliente Windows.
 */
const electron = vi.hoisted(() => {
  const handlers = new Map<
    string,
    (event?: unknown, ...args: unknown[]) => Promise<unknown> | unknown
  >();
  const logsPath = `/tmp/nexus-updater-mixed-test-${process.pid}`;
  return {
    handlers,
    logsPath,
    app: {
      isPackaged: true,
      getVersion: () => '0.76.41',
      getPath: () => logsPath,
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
import { buildSquirrelFeed, parseGhReleases } from './update-source';

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

function macAsset(version: string) {
  return { name: `NexusIDE-darwin-arm64-${version}.zip` };
}

function windowsAssets(version: string) {
  return [
    { name: `NexusIDE-${version}-win32-x64-Setup.exe` },
    { name: `nexus_ide-${version}-full.nupkg` },
    { name: 'RELEASES' },
  ];
}

function fullRelease(version: string) {
  return {
    tag_name: `v${version}`,
    published_at: '2026-09-10T20:00:00Z',
    draft: false,
    prerelease: false,
    assets: [macAsset(version), ...windowsAssets(version)],
  };
}

/** v0.76.42: mac já publicado, Windows ainda "anexado depois" (pending). */
const MAC_ONLY_NEWEST = {
  tag_name: 'v0.76.42',
  published_at: '2026-09-16T12:00:00Z',
  draft: false,
  prerelease: false,
  assets: [macAsset('0.76.42')],
};

const MIXED_RELEASES = [
  fullRelease('0.76.40'),
  fullRelease('0.76.41'),
  MAC_ONLY_NEWEST,
];

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  electron.handlers.clear();
  vi.clearAllMocks();
  electron.app.isPackaged = true;
  rmSync(electron.logsPath, { recursive: true, force: true });
});

describe('mixed platform release list (mac-only newest, windows pending)', () => {
  it('(1) a mac client on 0.76.41 picks the mac-only 0.76.42 release, ignoring completeness of the Windows side', () => {
    const release = parseGhReleases(
      JSON.stringify(MIXED_RELEASES),
      '0.76.41',
      'arm64',
      'darwin',
    );
    expect(release).toMatchObject({
      version: '0.76.42',
      tag: 'v0.76.42',
      zipAsset: 'NexusIDE-darwin-arm64-0.76.42.zip',
    });
  });

  it('(1b) parseGhReleases unconditionally refuses to evaluate the list for a Windows runtime (defense in depth, update-source.ts:151)', () => {
    expect(
      parseGhReleases(JSON.stringify(MIXED_RELEASES), '0.76.41', 'x64', 'win32'),
    ).toBeNull();
  });

  it('(2) mac and Windows do not reach their decision from the same list — Windows never even fetches it', async () => {
    const runGh = vi.fn(async () => JSON.stringify(MIXED_RELEASES));
    const manager = new UpdateManager(true, {
      runGh,
      runtimeArch: 'x64',
      runtimePlatform: 'win32',
      appExecutablePath:
        'C:\\Users\\operator\\AppData\\Local\\NexusIDE\\app-0.76.41\\nexus-ide.exe',
      pathExists: (candidate) => candidate.endsWith('NexusIDE\\Update.exe'),
    });

    manager.init();
    expect(electron.autoUpdater.setFeedURL).toHaveBeenCalledWith({
      url: 'https://update.electronjs.org/Hiper-nexus/nexus-ide-releases/win32-x64/0.76.41',
    });

    const check = electron.handlers.get(UPDATE_CHANNELS.check);
    await check?.(trustedSenderEvent());

    // O caminho real do Windows instalado (mode: 'feed') delega inteiramente
    // ao Squirrel.Windows/update.electronjs.org — a lista mista do mac
    // (runGh) nunca é consultada, então não há decisão em comum para
    // "convergir": são dois mecanismos de dados inteiramente separados.
    expect(runGh).not.toHaveBeenCalled();
    expect(electron.autoUpdater.checkForUpdates).toHaveBeenCalledTimes(1);
  });

  it('(3) the local Squirrel.Mac feed always names the zip of the exact release parseGhReleases picked from the mixed list', () => {
    const release = parseGhReleases(
      JSON.stringify(MIXED_RELEASES),
      '0.76.41',
      'arm64',
      'darwin',
    );
    expect(release).not.toBeNull();

    const feedJson = buildSquirrelFeed(release!, 'http://127.0.0.1:54321/update.zip');
    const feed = JSON.parse(feedJson) as { url: string; name: string };

    expect(feed.url).toBe('http://127.0.0.1:54321/update.zip');
    expect(feed.name).toBe('v0.76.42');
    // updater.ts:790-797 serves exactly `path.join(dir, release.zipAsset)` at
    // that URL — the manifest and the bytes behind it always describe the
    // SAME release object, so the URL can never point at a stale version.
    expect(release!.zipAsset).toBe('NexusIDE-darwin-arm64-0.76.42.zip');
  });

  it('(4) a Windows client on 0.76.41 ignores the mac-only 0.76.42 without entering an error state', async () => {
    const runGh = vi.fn(async () => {
      throw new Error('modo feed nunca deveria chamar gh');
    });
    const manager = new UpdateManager(true, {
      runGh,
      runtimeArch: 'x64',
      runtimePlatform: 'win32',
      appExecutablePath:
        'C:\\Users\\operator\\AppData\\Local\\NexusIDE\\app-0.76.41\\nexus-ide.exe',
      pathExists: (candidate) => candidate.endsWith('NexusIDE\\Update.exe'),
    });

    manager.init();
    expect(manager.getState()).toMatchObject({
      phase: 'idle',
      source: 'feed',
      canInstall: true,
    });

    const check = electron.handlers.get(UPDATE_CHANNELS.check);
    await check?.(trustedSenderEvent());

    expect(manager.getState().phase).not.toBe('error');
    expect(electron.autoUpdater.checkForUpdates).toHaveBeenCalledTimes(1);
    expect(runGh).not.toHaveBeenCalled();
  });
});

/** Estado REAL de 16/09: v0.76.41 saiu só com Windows; v0.76.42 sai só com macOS. */
function windowsOnlyRelease(version: string) {
  return {
    tag_name: `v${version}`,
    published_at: '2026-09-16T16:28:57Z',
    draft: false,
    prerelease: false,
    assets: windowsAssets(version),
  };
}

describe('real 16/09 list: 0.76.41 windows-only, 0.76.42 mac-only', () => {
  it('(5) a mac client on 0.76.40 skips the windows-only 0.76.41 and is offered the mac-only 0.76.42', () => {
    const release = parseGhReleases(
      JSON.stringify([fullRelease('0.76.40'), windowsOnlyRelease('0.76.41'), MAC_ONLY_NEWEST]),
      '0.76.40',
      'arm64',
      'darwin',
    );
    expect(release).toMatchObject({
      version: '0.76.42',
      zipAsset: 'NexusIDE-darwin-arm64-0.76.42.zip',
    });
  });

  it('(6) before 0.76.42 exists, a mac client on 0.76.40 sees only the windows-only 0.76.41 and stays put without error', () => {
    const release = parseGhReleases(
      JSON.stringify([fullRelease('0.76.40'), windowsOnlyRelease('0.76.41')]),
      '0.76.40',
      'arm64',
      'darwin',
    );
    expect(release).toBeNull();
  });
});
