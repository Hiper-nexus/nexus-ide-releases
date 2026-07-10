import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PTY_CHANNELS } from '../../shared/channels';

const ipcDeps = vi.hoisted(() => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  return {
    handlers,
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      handlers.set(channel, handler);
    }),
    on: vi.fn(),
  };
});

const ptyDeps = vi.hoisted(() => ({
  spawnAgentSession: vi.fn(() => ({ sessionId: 'pty-created' })),
  spawnSession: vi.fn(() => ({ sessionId: 'shell-created' })),
  setPtyHost: vi.fn(),
}));

const providerDeps = vi.hoisted(() => ({
  prepareProviderSpawn: vi.fn(),
  providerReadiness: vi.fn(() => ({ ready: true, reason: 'ready' })),
  providerSpawnOverrides: vi.fn(() => ({
    binPath: '/usr/local/bin/claude',
    defaultModel: null,
    extraArgs: [],
    keyEnv: {},
    suppressEnv: [],
  })),
}));

vi.mock('electron', () => ({
  ipcMain: { handle: ipcDeps.handle, on: ipcDeps.on },
}));

vi.mock('./pty-manager', () => ({
  killSession: vi.fn(),
  resizeSession: vi.fn(),
  setPtyHost: ptyDeps.setPtyHost,
  spawnAgentSession: ptyDeps.spawnAgentSession,
  spawnSession: ptyDeps.spawnSession,
  writeSession: vi.fn(),
}));

vi.mock('./pty-host-client', () => ({
  createRealPtyHost: () => ({ kind: 'test-host' }),
}));

vi.mock('../adapters/adapter-registry', () => ({
  getAdapter: (id: string) =>
    id === 'claude'
      ? {
          id: 'claude',
          kind: 'cli-pty',
          label: 'Claude',
          install: { command: 'npm install claude' },
        }
      : null,
  isAdapterInstalled: () => true,
}));

vi.mock('../persistence/provider-config-store', () => ({
  isProviderEnabled: () => true,
  prepareProviderSpawn: providerDeps.prepareProviderSpawn,
  providerReadiness: providerDeps.providerReadiness,
  providerSpawnOverrides: providerDeps.providerSpawnOverrides,
}));

vi.mock('../persistence/account-store', () => ({
  getAccount: () => ({
    id: 'acct-selected',
    adapterId: 'claude',
    label: 'Selected',
  }),
}));

import { registerPtyIpc } from './pty-ipc';

describe('registerPtyIpc account fail-fast', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    ipcDeps.handlers.clear();
    registerPtyIpc();
  });

  it.each([
    'selected account does not belong to this provider',
    'selected account "Claude limite" is cooling down',
    'selected subscription "Claude Max" could not be activated',
    'selected account "Sem key" has no stored API credential',
  ])('rejects before creating a PTY: %s', (error) => {
    providerDeps.prepareProviderSpawn.mockReturnValueOnce({ ok: false, error });
    const handler = ipcDeps.handlers.get(PTY_CHANNELS.spawn);

    const result = handler?.(
      { sender: { id: 7 } },
      {
        kind: 'cli-agent',
        adapterId: 'claude',
        accountId: 'acct-selected',
        cols: 100,
        rows: 30,
      },
    );

    expect(result).toEqual({ ok: false, error });
    expect(providerDeps.prepareProviderSpawn).toHaveBeenCalledWith('claude', {
      effort: undefined,
      accountId: 'acct-selected',
    });
    expect(ptyDeps.spawnAgentSession).not.toHaveBeenCalled();
  });

  it('creates the PTY only after the exact account preparation succeeds', () => {
    const overrides = {
      binPath: '/usr/local/bin/claude',
      defaultModel: null,
      extraArgs: [],
      keyEnv: { ANTHROPIC_API_KEY: 'sk-selected' },
      suppressEnv: [],
    };
    providerDeps.prepareProviderSpawn.mockReturnValueOnce({
      ok: true,
      overrides,
    });
    const handler = ipcDeps.handlers.get(PTY_CHANNELS.spawn);
    const request = {
      kind: 'cli-agent' as const,
      adapterId: 'claude',
      accountId: 'acct-selected',
      cols: 100,
      rows: 30,
    };
    const sender = { id: 7 };

    const result = handler?.({ sender }, request);

    expect(result).toEqual({ ok: true, sessionId: 'pty-created' });
    expect(ptyDeps.spawnAgentSession).toHaveBeenCalledWith(
      sender,
      request,
      expect.objectContaining({ id: 'claude' }),
      overrides,
    );
  });
});
