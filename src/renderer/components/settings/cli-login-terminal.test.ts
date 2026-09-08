/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const layout = vi.hoisted(() => ({
  addShellPane: vi.fn(() => 'pane-login'),
  focus: vi.fn(),
  close: vi.fn(),
  renameTitle: vi.fn(),
  root: null,
}));

/** O pane de login some da árvore quando o operador o fecha. */
const panes = vi.hoisted(() => ({ open: [{ id: 'pane-login' }] }));

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
    { getState: () => layout, subscribe: () => () => undefined },
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
  listPanes: () => panes.open,
}));

import {
  cliLoginProvedNewSession,
  openCliLoginTerminal,
  type CliLoginFinish,
} from './cli-login-terminal';

describe('openCliLoginTerminal', () => {
  beforeEach(() => {
    layout.addShellPane.mockClear().mockReturnValue('pane-login');
    layout.focus.mockClear();
    layout.close.mockClear();
    layout.renameTitle.mockClear();
    navigation.openTerminal.mockClear();
    host.waitForSession.mockClear().mockResolvedValue('session-login');
    host.writeToPane.mockClear();
    panes.open = [{ id: 'pane-login' }];
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
      adapterLabel: 'Claude',
    });

    expect(result).toEqual({ ok: true, paneId: 'pane-login' });
    expect(order).toEqual(['addShellPane', 'waitForSession', 'openTerminal']);
    expect(layout.addShellPane).toHaveBeenCalledWith({ focus: false });
    expect(layout.renameTitle).toHaveBeenCalledWith('pane-login', 'Login Claude');
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

describe('cliLoginProvedNewSession — o que autoriza gravar uma conta nova', () => {
  const ok = (extra: Record<string, unknown> = {}) => ({
    adapterId: 'codex',
    state: 'ok' as const,
    detail: 'sessão viva',
    ...extra,
  });

  it('sonda ainda sem sessão nunca prova login', () => {
    expect(
      cliLoginProvedNewSession(
        { adapterId: 'codex', state: 'missing', detail: 'precisa login' },
        { adapterId: 'codex', state: 'missing', detail: 'precisa login' },
      ),
    ).toBe(false);
    // Sonda muda, mas sem prova de sessão nenhuma.
    expect(cliLoginProvedNewSession(ok(), null)).toBe(false);
  });

  it('não havia sessão e agora há: primeiro login provado', () => {
    expect(
      cliLoginProvedNewSession(
        { adapterId: 'codex', state: 'missing', detail: 'precisa login' },
        ok(),
      ),
    ).toBe(true);
    expect(cliLoginProvedNewSession(null, ok())).toBe(true);
  });

  it('CLI que JÁ estava logada só prova com a sessão trocando', () => {
    // Cancelou o login: mesma sessão dos dois lados.
    expect(
      cliLoginProvedNewSession(
        ok({ sessionFingerprint: 'aaa' }),
        ok({ sessionFingerprint: 'aaa' }),
      ),
    ).toBe(false);
    // Entrou na conta B: fingerprint diferente.
    expect(
      cliLoginProvedNewSession(
        ok({ sessionFingerprint: 'aaa' }),
        ok({ sessionFingerprint: 'bbb' }),
      ),
    ).toBe(true);
    // Reautenticou a MESMA conta: o blob rodou, o fingerprint mudou.
    expect(
      cliLoginProvedNewSession(
        ok({ sessionFingerprint: 'velho', detail: 'sessão viva: dev@example.com' }),
        ok({ sessionFingerprint: 'novo', detail: 'sessão viva: dev@example.com' }),
      ),
    ).toBe(true);
  });

  it('sem fingerprint, o e-mail da sonda ainda distingue A de B', () => {
    expect(
      cliLoginProvedNewSession(
        ok({ detail: 'sessão viva: a@example.com' }),
        ok({ detail: 'sessão viva: b@example.com' }),
      ),
    ).toBe(true);
    expect(
      cliLoginProvedNewSession(
        ok({ detail: 'sessão viva: a@example.com' }),
        ok({ detail: 'sessão viva: A@Example.com' }),
      ),
    ).toBe(false);
  });

  it('CLI sem identidade nenhuma não vira conta nova por adivinhação', () => {
    expect(
      cliLoginProvedNewSession(
        ok({ detail: 'sessão viva' }),
        ok({ detail: 'sessão viva' }),
      ),
    ).toBe(false);
  });

  it('fingerprint vence o e-mail: dois workspaces com o mesmo e-mail são contas diferentes', () => {
    expect(
      cliLoginProvedNewSession(
        ok({ sessionFingerprint: 'ws-1', detail: 'sessão viva: dev@example.com' }),
        ok({ sessionFingerprint: 'ws-2', detail: 'sessão viva: dev@example.com' }),
      ),
    ).toBe(true);
  });
});

/**
 * O watcher inteiro, com o pane de login já fechado: o único caminho que
 * resta é a sonda. É onde "fechei o terminal" tem de PARAR de virar sucesso.
 */
describe('openCliLoginTerminal — o que o watcher entrega ao fechar', () => {
  const baseline = {
    adapterId: 'codex',
    state: 'ok' as const,
    detail: 'sessão viva',
    sessionFingerprint: 'antes',
  };

  function stubProbe(status: Record<string, unknown> | null): void {
    Object.defineProperty(window, 'nexus', {
      configurable: true,
      value: {
        providers: { authStatus: vi.fn(async () => (status ? [status] : [])) },
        pty: { onData: vi.fn(() => () => undefined) },
      },
    });
  }

  beforeEach(() => {
    layout.addShellPane.mockClear().mockReturnValue('pane-login');
    host.waitForSession.mockClear().mockResolvedValue('session-login');
    // Pane fechado antes de o watcher olhar pela primeira vez.
    panes.open = [];
  });

  afterEach(() => {
    Reflect.deleteProperty(window, 'nexus');
  });

  it('fechar o terminal sem trocar de sessão NÃO é login novo', async () => {
    stubProbe({ ...baseline });
    const finished: CliLoginFinish[] = [];
    await openCliLoginTerminal({
      command: 'codex login',
      adapterId: 'codex',
      baseline,
      onFinished: (finish) => finished.push(finish),
    });
    await vi.waitFor(() => expect(finished).toHaveLength(1));
    expect(finished[0]!.verified).toBe(false);
  });

  it('fechar o terminal DEPOIS de entrar na conta B é login novo', async () => {
    stubProbe({ ...baseline, sessionFingerprint: 'depois' });
    const finished: CliLoginFinish[] = [];
    await openCliLoginTerminal({
      command: 'codex login',
      adapterId: 'codex',
      baseline,
      onFinished: (finish) => finished.push(finish),
    });
    await vi.waitFor(() => expect(finished).toHaveLength(1));
    expect(finished[0]!.verified).toBe(true);
    expect(finished[0]!.status?.sessionFingerprint).toBe('depois');
  });

  it('sonda indisponível ao fechar não inventa sucesso', async () => {
    stubProbe(null);
    const finished: CliLoginFinish[] = [];
    await openCliLoginTerminal({
      command: 'codex login',
      adapterId: 'codex',
      baseline,
      onFinished: (finish) => finished.push(finish),
    });
    await vi.waitFor(() => expect(finished).toHaveLength(1));
    expect(finished[0]!.verified).toBe(false);
  });
});
