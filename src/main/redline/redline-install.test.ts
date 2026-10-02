import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const handleTrusted = vi.hoisted(() => vi.fn());
const showMessageBox = vi.hoisted(() => vi.fn());
const ipcHandle = vi.hoisted(() => vi.fn());
const removeHandler = vi.hoisted(() => vi.fn());
const openQuotaInMainWindow = vi.hoisted(() => vi.fn());
const linux = vi.hoisted(() => ({
  controller: {
    startIfEnabled: vi.fn(),
    enable: vi.fn(),
    disable: vi.fn(),
    stop: vi.fn(),
    status: vi.fn(),
  },
  create: vi.fn(),
}));

vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: () => '/tmp' },
  BrowserWindow: {
    getFocusedWindow: () => null,
    getAllWindows: () => [],
  },
  dialog: { showMessageBox },
  ipcMain: { handle: ipcHandle, removeHandler },
}));

vi.mock('../security/trusted-ipc', () => ({
  handleTrusted,
}));

vi.mock('../deep-link', () => ({ openQuotaInMainWindow }));

vi.mock('./redline-linux', () => ({
  createRedlineLinuxController: (deps: unknown) => {
    linux.create(deps);
    return linux.controller;
  },
}));

import { REDLINE_IPC } from '../../shared/redline-types';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  confirmAndInstallRedline,
  hideRedline,
  initRedlineIpc,
  installRedline,
  maybeOfferRedlineInstall,
  openRedline,
  redlineAppNeedsReplace,
  redlineStatus,
  shutdownRedlineIpc,
  startRedlineLinuxIfEnabled,
  syncInstalledRedline,
} from './redline-install';

async function withPlatform<T>(platform: NodeJS.Platform, run: () => Promise<T> | T): Promise<T> {
  const original = process.platform;
  Object.defineProperty(process, 'platform', { value: platform });
  try {
    return await run();
  } finally {
    Object.defineProperty(process, 'platform', { value: original });
  }
}

describe('redline install IPC', () => {
  beforeEach(() => {
    handleTrusted.mockReset();
    showMessageBox.mockReset();
    ipcHandle.mockReset();
    removeHandler.mockReset();
  });

  it('registers status/install/open/hide through handleTrusted', () => {
    initRedlineIpc();
    expect(handleTrusted.mock.calls.map((call) => call[0])).toEqual([
      REDLINE_IPC.status,
      REDLINE_IPC.install,
      REDLINE_IPC.open,
      REDLINE_IPC.hide,
    ]);
    expect(ipcHandle).not.toHaveBeenCalled();
  });

  it('untrusted sender never reaches install — handleTrusted is the gate', () => {
    initRedlineIpc();
    const installHandler = handleTrusted.mock.calls.find(
      (call) => call[0] === REDLINE_IPC.install,
    )?.[1];
    expect(installHandler).toEqual(expect.any(Function));
    // Denial of unverified senders is the handleTrusted seam
    // (src/main/security/trusted-ipc.test.ts). This file only proves the
    // privileged copy is behind that seam, not raw ipcMain.handle.
  });

  it('confirmAndInstallRedline does not copy when the operator cancels', async () => {
    const platform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    try {
      showMessageBox.mockResolvedValue({ response: 0 });
      const result = await confirmAndInstallRedline('/no-such-resources');
      expect(result.ok).toBe(false);
      expect(result.message).toMatch(/cancelada/i);
    } finally {
      Object.defineProperty(process, 'platform', { value: platform });
    }
  });

  it('installRedline refuses a platform that has no Redline at all', async () => {
    await withPlatform('freebsd', async () => {
      const result = await installRedline();
      expect(result.ok).toBe(false);
      expect(result.message).toMatch(/macOS/i);
      expect(linux.controller.enable).not.toHaveBeenCalled();
    });
  });

  it('shutdown removes the four handlers and stops the Linux tray', () => {
    shutdownRedlineIpc();
    expect(removeHandler.mock.calls.map((call) => call[0])).toEqual([
      REDLINE_IPC.status,
      REDLINE_IPC.install,
      REDLINE_IPC.open,
      REDLINE_IPC.hide,
    ]);
  });
});

describe('redline install — Linux tray inside the app', () => {
  beforeEach(() => {
    for (const fn of Object.values(linux.controller)) fn.mockReset();
    showMessageBox.mockReset();
    openQuotaInMainWindow.mockReset();
    linux.controller.status.mockReturnValue({ enabled: false, state: 'off' });
  });

  describe('status', () => {
    it('reports the in-app tray: bundled by construction, nothing to install', async () => {
      await withPlatform('linux', () => {
        linux.controller.status.mockReturnValue({ enabled: false, state: 'off' });
        expect(redlineStatus('/res')).toEqual({
          platform: 'linux',
          bundled: true,
          running: false,
          inAppTray: { enabled: false, state: 'off' },
        });
      });
    });

    it('running reflects the tray state', async () => {
      await withPlatform('linux', () => {
        linux.controller.status.mockReturnValue({ enabled: true, state: 'running' });
        const status = redlineStatus('/res');
        expect(status.running).toBe(true);
        expect(status.inAppTray).toEqual({ enabled: true, state: 'running' });
        expect(status.installedPath).toBeUndefined();
        expect(status.bundledPath).toBeUndefined();
      });
    });

    it('carries the reason when the tray is unavailable', async () => {
      await withPlatform('linux', () => {
        linux.controller.status.mockReturnValue({
          enabled: true,
          state: 'unavailable',
          reason: 'sem host de bandeja',
        });
        const status = redlineStatus('/res');
        expect(status.running).toBe(false);
        expect(status.inAppTray?.reason).toBe('sem host de bandeja');
      });
    });

    it.each(['darwin', 'win32'] as const)(
      '%s status never goes through the Linux controller and has no inAppTray',
      async (platform) => {
        await withPlatform(platform, () => {
          const status = redlineStatus('/res');
          expect(status.platform).toBe(platform);
          expect(status.inAppTray).toBeUndefined();
          expect(linux.controller.status).not.toHaveBeenCalled();
        });
      },
    );
  });

  describe('install = enable the tray', () => {
    it('enables with NO native dialog (it only writes to userData)', async () => {
      linux.controller.enable.mockReturnValue({ enabled: true, state: 'running' });
      await withPlatform('linux', async () => {
        const result = await confirmAndInstallRedline('/res');
        expect(result.ok).toBe(true);
        expect(result.message).toMatch(/bandeja/i);
        expect(result.message).toMatch(/enquanto o NexusIDE estiver aberto/i);
        expect(showMessageBox).not.toHaveBeenCalled();
        expect(linux.controller.enable).toHaveBeenCalledTimes(1);
      });
    });

    it('never says "barra do menu" or "Mac" on Linux', async () => {
      linux.controller.enable.mockReturnValue({ enabled: true, state: 'running' });
      await withPlatform('linux', async () => {
        const result = await installRedline('/res');
        expect(result.message).not.toMatch(/barra do menu|Mac|\/Applications/i);
      });
    });

    it('surfaces the reason when the tray cannot be created', async () => {
      linux.controller.enable.mockReturnValue({
        enabled: false,
        state: 'unavailable',
        reason: 'Não consegui criar o ícone na bandeja (sem host).',
      });
      await withPlatform('linux', async () => {
        const result = await installRedline('/res');
        expect(result).toEqual({
          ok: false,
          message: 'Não consegui criar o ícone na bandeja (sem host).',
        });
      });
    });

    it('a controller that throws becomes a clean failure, not an IPC rejection', async () => {
      linux.controller.enable.mockImplementation(() => {
        throw new Error('disco cheio');
      });
      await withPlatform('linux', async () => {
        const result = await installRedline('/res');
        expect(result.ok).toBe(false);
        expect(result.message).toContain('disco cheio');
      });
    });
  });

  describe('open', () => {
    it('running: points at the tray icon instead of pretending to open a panel', async () => {
      linux.controller.status.mockReturnValue({ enabled: true, state: 'running' });
      await withPlatform('linux', async () => {
        const result = await openRedline();
        expect(result.ok).toBe(true);
        expect(result.message).toMatch(/bandeja do sistema/i);
        expect(linux.controller.enable).not.toHaveBeenCalled();
      });
    });

    it('off: says it is off, does not turn it on behind the operator\'s back', async () => {
      linux.controller.status.mockReturnValue({ enabled: false, state: 'off' });
      await withPlatform('linux', async () => {
        const result = await openRedline();
        expect(result.ok).toBe(false);
        expect(result.message).toMatch(/desligado/i);
        expect(linux.controller.enable).not.toHaveBeenCalled();
      });
    });

    it('enabled but unavailable: retries creating the tray', async () => {
      linux.controller.status.mockReturnValue({ enabled: true, state: 'unavailable', reason: 'x' });
      linux.controller.enable.mockReturnValue({ enabled: true, state: 'running' });
      await withPlatform('linux', async () => {
        const result = await openRedline();
        expect(result.ok).toBe(true);
        expect(linux.controller.enable).toHaveBeenCalledTimes(1);
      });
    });
  });

  describe('hide', () => {
    it('disables the tray on Linux', async () => {
      linux.controller.disable.mockReturnValue({ enabled: false, state: 'off' });
      await withPlatform('linux', () => {
        const result = hideRedline();
        expect(result.ok).toBe(true);
        expect(result.message).toMatch(/saiu da bandeja/i);
        expect(linux.controller.disable).toHaveBeenCalledTimes(1);
      });
    });

    it('reports a failure to save instead of throwing', async () => {
      linux.controller.disable.mockImplementation(() => {
        throw new Error('EACCES');
      });
      await withPlatform('linux', () => {
        const result = hideRedline();
        expect(result.ok).toBe(false);
        expect(result.message).toContain('EACCES');
      });
    });

    it.each(['darwin', 'win32'] as const)('is a refused no-op on %s', async (platform) => {
      await withPlatform(platform, () => {
        const result = hideRedline();
        expect(result.ok).toBe(false);
        expect(result.message).toMatch(/Linux/);
        expect(linux.controller.disable).not.toHaveBeenCalled();
      });
    });
  });

  describe('boot and update hooks', () => {
    it('startRedlineLinuxIfEnabled starts the tray only on Linux', async () => {
      await withPlatform('linux', () => startRedlineLinuxIfEnabled());
      expect(linux.controller.startIfEnabled).toHaveBeenCalledTimes(1);
      linux.controller.startIfEnabled.mockClear();
      await withPlatform('darwin', () => startRedlineLinuxIfEnabled());
      await withPlatform('win32', () => startRedlineLinuxIfEnabled());
      expect(linux.controller.startIfEnabled).not.toHaveBeenCalled();
    });

    it('a controller that blows up at boot never crashes the app', async () => {
      linux.controller.startIfEnabled.mockImplementation(() => {
        throw new Error('boom');
      });
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      await withPlatform('linux', () => {
        expect(() => startRedlineLinuxIfEnabled()).not.toThrow();
      });
      expect(warn).toHaveBeenCalled();
      warn.mockRestore();
    });

    it('syncInstalledRedline is a no-op on Linux (no installed copy to refresh)', async () => {
      await withPlatform('linux', async () => {
        await syncInstalledRedline('/res');
        expect(linux.controller.enable).not.toHaveBeenCalled();
        expect(linux.controller.startIfEnabled).not.toHaveBeenCalled();
      });
    });

    it('no one-time install offer is shown on Linux (opt-in lives in Uso e cotas)', async () => {
      await withPlatform('linux', async () => {
        await maybeOfferRedlineInstall('/tmp/nope');
        expect(showMessageBox).not.toHaveBeenCalled();
      });
    });

    it('the tray opens Uso e cotas through the same path as nexus://quota', async () => {
      // Módulo novo: o controller é criado sob demanda, na primeira chamada.
      vi.resetModules();
      const fresh = await import('./redline-install');
      linux.create.mockClear();
      await withPlatform('linux', () => {
        fresh.redlineStatus('/res');
      });
      expect(linux.create).toHaveBeenCalledTimes(1);
      const deps = linux.create.mock.calls[0]?.[0] as { openQuota: () => void; userDataDir: string };
      expect(deps.userDataDir).toBe('/tmp');
      deps.openQuota();
      expect(openQuotaInMainWindow).toHaveBeenCalledTimes(1);
    });
  });
});

describe('redlineAppNeedsReplace (F-612)', () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0))
      rmSync(root, { recursive: true, force: true });
  });
  function fakeApp(bytes: Buffer): string {
    const root = mkdtempSync(path.join(tmpdir(), 'redline-app-'));
    roots.push(root);
    const exec = path.join(root, 'Contents', 'MacOS', 'NexusRedline');
    mkdirSync(path.dirname(exec), { recursive: true });
    writeFileSync(exec, bytes);
    return root;
  }

  it('is true when the bundled companion differs from /Applications', () => {
    const bundled = fakeApp(Buffer.from('bundled-v2'));
    const installed = fakeApp(Buffer.from('installed-v1'));
    expect(redlineAppNeedsReplace(bundled, installed)).toBe(true);
  });

  it('is false when the binaries are identical', () => {
    const bytes = Buffer.from('same-build');
    expect(redlineAppNeedsReplace(fakeApp(bytes), fakeApp(bytes))).toBe(false);
  });

  it('is true when the installed executable is missing', () => {
    const bundled = fakeApp(Buffer.from('bundled'));
    const installed = mkdtempSync(path.join(tmpdir(), 'redline-empty-'));
    roots.push(installed);
    expect(redlineAppNeedsReplace(bundled, installed)).toBe(true);
  });
});
