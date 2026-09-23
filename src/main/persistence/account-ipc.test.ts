import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ACCOUNT_CHANNELS } from '../../shared/account-types';

const deps = vi.hoisted(() => ({
  handlers: new Map<string, (_event: unknown, payload: unknown) => unknown>(),
  addAuthoritative: vi.fn(async () => ({
    id: 'acct-b', adapterId: 'claude', label: 'Conta B', email: 'b@example.test',
  })),
  resetDeaths: vi.fn(),
}));

vi.mock('electron', () => ({ ipcMain: {
  handle: (channel: string, handler: (_event: unknown, payload: unknown) => unknown) =>
    deps.handlers.set(channel, handler),
} }));
vi.mock('../security/trusted-ipc', () => ({
  handleTrusted: (channel: string, handler: (_event: unknown, payload: unknown) => unknown) =>
    deps.handlers.set(channel, handler),
}));
vi.mock('./db', () => ({ getDb: () => null }));
vi.mock('./account-store', () => ({
  initAccountStore: vi.fn(), onAccountsChange: vi.fn(), listAccountInfos: vi.fn(() => []),
  supportsSessionSnapshot: vi.fn(() => true),
  addActiveSessionAccountAuthoritative: deps.addAuthoritative,
  addActiveClaudeAccount: vi.fn(), addAccount: vi.fn(), activateAccount: vi.fn(),
  getAccount: vi.fn(), removeAccount: vi.fn(), renameAccount: vi.fn(),
}));
vi.mock('./account-quota', () => ({ listAccountQuota: vi.fn(() => []) }));
vi.mock('../orch/failover', () => ({
  initFailover: vi.fn(), registerFailoverListener: vi.fn(),
  resetInstantAuthDeaths: deps.resetDeaths, unregisterFailoverListener: vi.fn(),
}));

import { registerAccountIpc } from './account-ipc';

beforeEach(() => {
  deps.handlers.clear();
  deps.addAuthoritative.mockClear();
  deps.resetDeaths.mockClear();
  registerAccountIpc();
});

describe('account IPC Claude re-login', () => {
  it('awaits provider-backed capture for the exact targeted account', async () => {
    const handler = deps.handlers.get(ACCOUNT_CHANNELS.addActiveSession);
    const result = await handler?.({}, {
      adapterId: 'claude', label: 'Conta B', accountId: 'acct-b',
    });

    expect(deps.addAuthoritative).toHaveBeenCalledWith('claude', 'Conta B', 'acct-b');
    expect(result).toEqual({ ok: true, id: 'acct-b', email: 'b@example.test' });
    expect(deps.resetDeaths).toHaveBeenCalledWith('claude');
  });

  it('uses provider-backed capture for a new Claude account as well', async () => {
    const handler = deps.handlers.get(ACCOUNT_CHANNELS.addActiveClaude);
    const result = await handler?.({}, { label: 'Conta B' });

    expect(deps.addAuthoritative).toHaveBeenCalledWith('claude', 'Conta B');
    expect(result).toEqual({ ok: true, id: 'acct-b', email: 'b@example.test' });
  });
});
