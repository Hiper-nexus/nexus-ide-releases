import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
}));

vi.mock('../persistence/provider-config-store', () => ({
  listProviderSettings: () => [
    { adapterId: 'claude', installed: true, hasKey: false },
    { adapterId: 'grok', installed: true, hasKey: false },
    { adapterId: 'kimi', installed: true, hasKey: false },
    { adapterId: 'opencode', installed: true, hasKey: false },
    { adapterId: 'aider', installed: true, hasKey: true },
  ],
}));

vi.mock('./subscription-auth', () => ({
  hasSubscriptionAuth: (adapterId: string) => adapterId === 'grok',
  detectSubscriptionAuth: (adapterId: string) =>
    adapterId === 'grok' || adapterId === 'claude',
  claudeOauthEmail: () => 'retornoja@gmail.com',
}));

import { probeAdapterAuth } from './auth-probe';

describe('probeAdapterAuth provider-specific diagnostics', () => {
  it('reports current login commands and treats Aider as API-key-only', async () => {
    const result = await probeAdapterAuth();
    const byId = Object.fromEntries(result.map((entry) => [entry.adapterId, entry]));

    expect(byId.claude).toMatchObject({
      state: 'ok',
      detail: expect.stringContaining('retornoja@gmail.com'),
    });
    expect(byId.grok).toMatchObject({ state: 'ok' });
    expect(byId.kimi).toMatchObject({
      state: 'missing',
      detail: expect.stringContaining('kimi login'),
    });
    expect(byId.opencode).toMatchObject({
      state: 'missing',
      detail: expect.stringContaining('opencode auth login'),
    });
    expect(byId.aider).toEqual({
      adapterId: 'aider',
      state: 'ok',
      detail: 'API key no cofre',
    });
  });
});
