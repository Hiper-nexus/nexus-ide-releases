import { beforeEach, describe, expect, it, vi } from 'vitest';
import { REMOTE_CHANNELS } from '../../shared/remote-channels';
import type { ProjectExecutionScope } from '../../shared/types';

interface TestOwner {
  id: number;
  isDestroyed(): boolean;
  isCrashed(): boolean;
  destroy(): void;
  crash(): void;
}

const harness = vi.hoisted(() => {
  const handlers = new Map<string, (...args: any[]) => unknown>();
  const scopes = new Map<number, ProjectExecutionScope>();
  const windows = new Map<number, { isDestroyed(): boolean }>();
  return {
    handlers,
    scopes,
    windows,
    dialog: {
      showMessageBox: vi.fn(
        async (_window: unknown, _options: Record<string, unknown>) => ({ response: 1 }),
      ),
    },
    ipcMain: {
      handle: vi.fn((channel: string, handler: (...args: any[]) => unknown) => {
        handlers.set(channel, handler);
      }),
    },
    BrowserWindow: {
      fromWebContents: vi.fn((owner: { id: number }) => windows.get(owner.id) ?? null),
    },
    detectRemoteClis: vi.fn(),
    listRemoteTmuxSessions: vi.fn(),
    createRemoteTmuxSession: vi.fn(async (request) => ({
      ok: true,
      target: request.target,
      sessionName: request.sessionName ?? 'generated',
    })),
  };
});

vi.mock('electron', () => ({
  BrowserWindow: harness.BrowserWindow,
  dialog: harness.dialog,
  ipcMain: harness.ipcMain,
}));

vi.mock('../persistence/renderer-workspace-scope', () => ({
  requireLiveRendererWorkspaceScope: (
    owner: TestOwner,
    expected?: ProjectExecutionScope,
  ) => {
    if (owner.isDestroyed() || owner.isCrashed()) {
      throw new Error('renderer is unavailable');
    }
    const current = harness.scopes.get(owner.id);
    if (!current) throw new Error('renderer has no authorized workspace scope');
    if (
      expected &&
      (current.installationId !== expected.installationId ||
        current.projectId !== expected.projectId ||
        current.checkoutId !== expected.checkoutId ||
        current.rootRealPath !== expected.rootRealPath)
    ) {
      throw new Error('renderer workspace authority changed');
    }
    return current;
  },
}));

vi.mock('./remote-spawn', () => ({
  detectRemoteClis: harness.detectRemoteClis,
  listRemoteTmuxSessions: harness.listRemoteTmuxSessions,
  createRemoteTmuxSession: harness.createRemoteTmuxSession,
}));

vi.mock('./remote-bridge', () => ({
  getRemoteBridgeInfo: vi.fn(() => ({ running: false, urls: [], tokenCount: 0, clientCount: 0 })),
  revokeRemoteTokens: vi.fn(),
  rotateRemotePairing: vi.fn(),
  startRemoteBridge: vi.fn(),
  stopRemoteBridge: vi.fn(),
}));

import { registerRemoteIpc } from './remote-ipc';

const SCOPE_A = Object.freeze({
  version: 1 as const,
  installationId: 'installation-a',
  projectId: 'project-a',
  checkoutId: 'checkout-a',
  rootRealPath: '/workspace/a',
  identitySource: 'manifest' as const,
});
const SCOPE_B = Object.freeze({
  ...SCOPE_A,
  projectId: 'project-b',
  checkoutId: 'checkout-b',
  rootRealPath: '/workspace/b',
});

function owner(id = 1): TestOwner {
  let destroyed = false;
  let crashed = false;
  return {
    id,
    isDestroyed: () => destroyed,
    isCrashed: () => crashed,
    destroy: () => {
      destroyed = true;
    },
    crash: () => {
      crashed = true;
    },
  };
}

async function invoke<T>(channel: string, sender: ReturnType<typeof owner>, raw?: unknown) {
  const handler = harness.handlers.get(channel);
  if (!handler) throw new Error(`missing handler: ${channel}`);
  return (await handler({ sender }, raw)) as T;
}

const SPAWN_REQUEST = Object.freeze({
  target: 'dev@example.com',
  cwd: '/srv/nexus',
  cli: 'codex' as const,
  sessionName: 'nexus-release',
  prompt: 'private prompt body',
});

beforeEach(() => {
  harness.handlers.clear();
  harness.scopes.clear();
  harness.windows.clear();
  vi.clearAllMocks();
  harness.dialog.showMessageBox.mockResolvedValue({ response: 1 });
  registerRemoteIpc();
});

describe('remote IPC renderer authority', () => {
  it('rejects SSH discovery and tmux listing without a live authorized scope', async () => {
    const sender = owner();

    await expect(
      invoke(REMOTE_CHANNELS.remoteSpawnDetect, sender, { target: 'dev@example.com' }),
    ).rejects.toThrow(/no authorized workspace scope/i);
    sender.destroy();
    harness.scopes.set(sender.id, SCOPE_A);
    await expect(
      invoke(REMOTE_CHANNELS.remoteSpawnList, sender, { target: 'dev@example.com' }),
    ).rejects.toThrow(/renderer is unavailable/i);
    expect(harness.detectRemoteClis).not.toHaveBeenCalled();
    expect(harness.listRemoteTmuxSessions).not.toHaveBeenCalled();
  });

  it('requires a main-owned confirmation for every remote spawn invocation', async () => {
    const sender = owner();
    harness.scopes.set(sender.id, SCOPE_A);
    harness.windows.set(sender.id, { isDestroyed: () => false });

    await invoke(REMOTE_CHANNELS.remoteSpawnCreate, sender, SPAWN_REQUEST);
    await invoke(REMOTE_CHANNELS.remoteSpawnCreate, sender, SPAWN_REQUEST);

    expect(harness.dialog.showMessageBox).toHaveBeenCalledTimes(2);
    expect(harness.createRemoteTmuxSession).toHaveBeenCalledTimes(2);
    const confirmation = harness.dialog.showMessageBox.mock.calls[0]![1];
    expect(confirmation).toMatchObject({ defaultId: 0, cancelId: 0, noLink: true });
    expect(confirmation.detail).toContain(SCOPE_A.rootRealPath);
    expect(confirmation.detail).toContain(SPAWN_REQUEST.target);
    expect(confirmation.detail).not.toContain(SPAWN_REQUEST.prompt);
  });

  it('does not spawn when the user denies the exact invocation', async () => {
    const sender = owner();
    harness.scopes.set(sender.id, SCOPE_A);
    harness.windows.set(sender.id, { isDestroyed: () => false });
    harness.dialog.showMessageBox.mockResolvedValueOnce({ response: 0 });

    await expect(
      invoke<{ ok: boolean; error?: string }>(
        REMOTE_CHANNELS.remoteSpawnCreate,
        sender,
        SPAWN_REQUEST,
      ),
    ).resolves.toEqual({
      ok: false,
      target: SPAWN_REQUEST.target,
      error: 'user_denied',
    });
    expect(harness.createRemoteTmuxSession).not.toHaveBeenCalled();
  });

  it('invalidates approval if the renderer changes project during confirmation', async () => {
    const sender = owner();
    harness.scopes.set(sender.id, SCOPE_A);
    harness.windows.set(sender.id, { isDestroyed: () => false });
    harness.dialog.showMessageBox.mockImplementationOnce(async () => {
      harness.scopes.set(sender.id, SCOPE_B);
      return { response: 1 };
    });

    await expect(
      invoke(REMOTE_CHANNELS.remoteSpawnCreate, sender, {
        ...SPAWN_REQUEST,
        scope: SCOPE_B,
      }),
    ).rejects.toThrow(/workspace authority changed/i);
    expect(harness.createRemoteTmuxSession).not.toHaveBeenCalled();
  });

  it('invalidates approval if the renderer dies during confirmation', async () => {
    const sender = owner();
    harness.scopes.set(sender.id, SCOPE_A);
    harness.windows.set(sender.id, { isDestroyed: () => false });
    harness.dialog.showMessageBox.mockImplementationOnce(async () => {
      sender.crash();
      return { response: 1 };
    });

    await expect(
      invoke(REMOTE_CHANNELS.remoteSpawnCreate, sender, SPAWN_REQUEST),
    ).rejects.toThrow(/renderer is unavailable/i);
    expect(harness.createRemoteTmuxSession).not.toHaveBeenCalled();
  });
});
