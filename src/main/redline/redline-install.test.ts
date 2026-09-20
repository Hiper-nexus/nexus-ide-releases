import { beforeEach, describe, expect, it, vi } from 'vitest';

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
import {
  confirmAndInstallRedline,
  initRedlineIpc,
  installRedline,
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
