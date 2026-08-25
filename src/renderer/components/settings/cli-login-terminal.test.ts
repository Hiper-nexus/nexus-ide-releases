/** @vitest-environment jsdom */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const layout = vi.hoisted(() => ({
  addShellPane: vi.fn(() => 'pane-login'),
  focus: vi.fn(),
  close: vi.fn(),
}));

const navigation = vi.hoisted(() => ({
  openTerminal: vi.fn(),
}));

const host = vi.hoisted(() => ({
  waitForSession: vi.fn(async (_paneId: string): Promise<string | null> => 'session-login'),
  writeToPane: vi.fn(),
}));

vi.mock('../../state/layout-store', () => ({
  useLayoutStore: Object.assign(
    () => layout,
    { getState: () => layout },
  ),
}));

vi.mock('../../state/product-navigation-store', () => ({
  useProductNavigationStore: Object.assign(
    () => navigation,
    { getState: () => navigation },
  ),
}));

vi.mock('../../terminal/terminal-host', () => ({
  waitForSession: (paneId: string) => host.waitForSession(paneId),
  writeToPane: (paneId: string, text: string) => host.writeToPane(paneId, text),
}));

vi.mock('../../state/provider-store', () => ({
  useProviderStore: Object.assign(
    () => ({ providers: [], hydrate: async () => undefined }),
    {
      getState: () => ({
        providers: [],
        hydrate: async () => undefined,
      }),
      subscribe: () => () => undefined,
    },
  ),
}));

vi.mock('../../state/session-state-store', () => ({
  useSessionStateStore: Object.assign(
    () => ({ paneStates: new Map() }),
    {
      getState: () => ({ paneStates: new Map() }),
      subscribe: () => () => undefined,
    },
  ),
}));

vi.mock('../../lib/split-tree', () => ({
  listPanes: () => [{ id: 'pane-login' }],
}));

import { openCliLoginTerminal } from './cli-login-terminal';

describe('openCliLoginTerminal', () => {
  beforeEach(() => {
    layout.addShellPane.mockClear().mockReturnValue('pane-login');
    layout.focus.mockClear();
    layout.close.mockClear();
    navigation.openTerminal.mockClear();
    host.waitForSession.mockClear().mockResolvedValue('session-login');
    host.writeToPane.mockClear();
  });

  it('espera a sessão e só então sai de Configurações (F-003)', async () => {
    const order: string[] = [];
    navigation.openTerminal.mockImplementation(() => order.push('openTerminal'));
    layout.addShellPane.mockImplementation(() => {
      order.push('addShellPane');
      return 'pane-login';
    });
    host.waitForSession.mockImplementation(async () => {
      order.push('waitForSession');
      return 'session-login';
    });

    const result = await openCliLoginTerminal({
      command: 'claude auth login',
      adapterId: 'claude',
    });

    expect(result).toEqual({ ok: true, paneId: 'pane-login' });
    expect(order).toEqual(['addShellPane', 'waitForSession', 'openTerminal']);
    expect(layout.addShellPane).toHaveBeenCalledWith({ focus: false });
    expect(host.writeToPane).toHaveBeenCalledWith(
      'pane-login',
      'claude auth login\n',
    );
    expect(layout.focus).toHaveBeenCalledWith('pane-login');
    expect(layout.close).not.toHaveBeenCalled();
  });

  it('fica em Configurações e anuncia se a sessão não nascer', async () => {
    host.waitForSession.mockResolvedValueOnce(null);
    const result = await openCliLoginTerminal({
      command: 'claude auth login',
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.error).toMatch(/login não foi iniciado/i);
    expect(layout.close).toHaveBeenCalledWith(
      'pane-login',
      'cli-login-terminal-unavailable',
    );
    expect(navigation.openTerminal).not.toHaveBeenCalled();
  });
});
