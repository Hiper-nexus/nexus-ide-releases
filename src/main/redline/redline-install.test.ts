import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const handleTrusted = vi.hoisted(() => vi.fn());
const showMessageBox = vi.hoisted(() => vi.fn());
const ipcHandle = vi.hoisted(() => vi.fn());
const removeHandler = vi.hoisted(() => vi.fn());

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

import { REDLINE_IPC } from '../../shared/redline-types';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  confirmAndInstallRedline,
  initRedlineIpc,
  installRedline,
  redlineAppNeedsReplace,
  shutdownRedlineIpc,
} from './redline-install';

describe('redline install IPC', () => {
  beforeEach(() => {
    handleTrusted.mockReset();
    showMessageBox.mockReset();
    ipcHandle.mockReset();
    removeHandler.mockReset();
  });

  it('registers status/install/open through handleTrusted', () => {
    initRedlineIpc();
    expect(handleTrusted.mock.calls.map((call) => call[0])).toEqual([
      REDLINE_IPC.status,
      REDLINE_IPC.install,
      REDLINE_IPC.open,
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
    showMessageBox.mockResolvedValue({ response: 0 });
    const result = await confirmAndInstallRedline('/no-such-resources');
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/cancelada/i);
  });

  it('installRedline refuses non-darwin', async () => {
    const original = process.platform;
    Object.defineProperty(process, 'platform', { value: 'linux' });
    try {
      const result = await installRedline();
      expect(result.ok).toBe(false);
      expect(result.message).toMatch(/macOS/i);
    } finally {
      Object.defineProperty(process, 'platform', { value: original });
    }
  });

  it('shutdown removes the three handlers', () => {
    shutdownRedlineIpc();
    expect(removeHandler.mock.calls.map((call) => call[0])).toEqual([
      REDLINE_IPC.status,
      REDLINE_IPC.install,
      REDLINE_IPC.open,
    ]);
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
