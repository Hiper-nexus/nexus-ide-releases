/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AccountInfo } from '../../../shared/account-types';
import { useAccountStore } from '../../state/account-store';
import { useConfirmStore } from '../../state/confirm-store';
import { useUsageStore, EMPTY_USAGE_SNAPSHOT } from '../../state/usage-store';
import { openCliLoginTerminal } from './cli-login-terminal';
import { AccountsManager } from './AccountsManager';
import { useAccountReloginIntentStore } from '../../state/account-relogin-intent';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

/**
 * Terminal de login mockado. Guarda o `onFinished` E o baseline recebido: o
 * baseline é o contrato desta etapa, e o teste tem de poder afirmar que ele
 * foi colhido ANTES do terminal existir.
 */
interface LoginFinish {
  verified: boolean;
  status: { adapterId: string; state: string; detail: string } | null;
}
const loginTerminal = vi.hoisted(() => ({
  finish: null as null | ((result: unknown) => void),
  baseline: undefined as unknown,
}));
vi.mock('./cli-login-terminal', () => ({
  openCliLoginTerminal: vi.fn(
    async (input: { onFinished?: (r: unknown) => void; baseline?: unknown }) => {
      loginTerminal.finish = input.onFinished ?? null;
      loginTerminal.baseline = input.baseline;
      return { ok: true as const, paneId: 'pane-login' };
    },
  ),
}));

/** Encerra o terminal de login com o veredito que o watcher teria dado. */
function finishLogin(result: LoginFinish): void {
  loginTerminal.finish?.(result);
}

function account(patch: Partial<AccountInfo> = {}): AccountInfo {
  return {
    id: 'acct-1',
    adapterId: 'claude',
    label: 'Trabalho',
    mode: 'subscription',
    upstream: 'anthropic',
    email: 'dev@example.com',
    createdAt: 1,
    active: true,
    hasCredential: true,
    onCooldown: false,
    needsRelogin: false,
    ...patch,
  };
}

function mount(adapterId = 'claude'): { host: HTMLDivElement; root: Root } {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() =>
    root.render(
      <AccountsManager adapterId={adapterId} adapterLabel={adapterId} />,
    ),
  );
  return { host, root };
}

describe('AccountsManager', () => {
  beforeEach(() => {
    useAccountStore.setState({
      accounts: [],
      quota: [],
      restartAdapterId: null,
      restartLabel: null,
      addActiveSession: vi.fn(async () => ({ ok: true, email: 'dev@example.com' })),
      hydrate: vi.fn(async () => undefined),
    });
    useConfirmStore.setState({ pending: null, queue: [] });
    useUsageStore.setState({ snapshot: EMPTY_USAGE_SNAPSHOT });
    loginTerminal.finish = null;
    loginTerminal.baseline = undefined;
    Object.defineProperty(window, 'nexus', {
      configurable: true,
      value: {
        providers: {
          authStatus: vi.fn(async () => [
            { adapterId: 'claude', state: 'ok', detail: 'Logged in as dev@example.com' },
          ]),
        },
        accounts: {
          supportsSnapshot: vi.fn(async () => ({ ok: true, supported: true })),
        },
      },
    });
  });

  afterEach(() => {
    Reflect.deleteProperty(window, 'nexus');
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  // F-1642: o cartão "Não subiu" do pane pede o login de uma conta. Quem
  // atende é o mesmo «Entrar novamente» desta linha, com as mesmas guardas.
  describe('pedido de login vindo do pane (F-1642)', () => {
    const contaB = () => account({ id: 'acct-b', label: 'conta b', email: 'b@example.com', needsRelogin: true });
    const native = () => account({ id: 'acct-native', label: 'conta adm', active: false });

    afterEach(() => useAccountReloginIntentStore.setState({ pending: null }));

    it('abre o login da conta pedida, como reautenticação, e consome o pedido', async () => {
      useAccountStore.setState({ accounts: [contaB(), native()] });
      vi.mocked(openCliLoginTerminal).mockClear();
      useAccountReloginIntentStore.getState().request({ adapterId: 'claude', accountId: 'acct-b', accountLabel: 'conta b' });
      const { root } = mount();
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(openCliLoginTerminal).toHaveBeenCalledTimes(1);
      expect(openCliLoginTerminal).toHaveBeenCalledWith(expect.objectContaining({
        adapterId: 'claude', reauthenticate: true,
      }));
      expect(useAccountReloginIntentStore.getState().pending).toBeNull();
      act(() => root.unmount());
    });

    it('pedido de outra CLI ou de conta que não existe mais não abre login', async () => {
      useAccountStore.setState({ accounts: [contaB()] });
      vi.mocked(openCliLoginTerminal).mockClear();
      useAccountReloginIntentStore.getState().request({ adapterId: 'codex', accountId: 'acct-b', accountLabel: 'conta b' });
      const first = mount();
      await act(async () => { await Promise.resolve(); });
      act(() => first.root.unmount());
      useAccountReloginIntentStore.getState().request({ adapterId: 'claude', accountId: 'acct-gone', accountLabel: 'velha' });
      const second = mount();
      await act(async () => { await Promise.resolve(); });

      expect(openCliLoginTerminal).not.toHaveBeenCalled();
      act(() => second.root.unmount());
    });
  });

  it('shows implicit native session when vault is empty', async () => {
    const { host, root } = mount();
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(host.textContent).toContain('Sessão nativa de claude');
    expect(host.textContent).toContain('conectado');
    expect(host.textContent).toContain('Adicionar chave de API');
    expect(host.textContent).toMatch(/adicionar conta/i);
    expect(host.textContent).toContain('Salvar esta conta');
    expect(host.textContent).not.toMatch(/conectar minha conta/i);
    expect(host.textContent).not.toMatch(/1 ·/i);
    act(() => root.unmount());
  });

  it('offers one save action for the current session, without duplicate account cards', async () => {
    const { host, root } = mount();
    await act(async () => { await Promise.resolve(); });

    const saveActions = [...host.querySelectorAll('button')].filter((button) =>
      /Salvar (esta conta|conta logada)/i.test(button.textContent ?? ''),
    );
    expect(saveActions).toHaveLength(1);
    expect(host.querySelectorAll('.acct__add-choice')).toHaveLength(0);
    expect(host.textContent).not.toContain('Adicionar a 2ª conta');
    act(() => root.unmount());
  });

  it('offers an explicit retry when the login terminal could not open', async () => {
    vi.mocked(openCliLoginTerminal).mockResolvedValueOnce({
      ok: false, error: 'O terminal não ficou disponível. O login não foi iniciado.',
    });
    const { host, root } = mount();
    await act(async () => { await Promise.resolve(); });
    const addAccount = host.querySelector<HTMLButtonElement>(
      '[data-testid="acct-add-account"]',
    );
    await act(async () => { addAccount!.click(); });
    const login = host.querySelector<HTMLButtonElement>(
      '[data-testid="acct-add-account-login"]',
    );
    await act(async () => { login!.click(); });

    const retry = [...host.querySelectorAll('button')].find((button) =>
      button.textContent === 'Tentar abrir novamente',
    );
    expect(retry).toBeTruthy();
    await act(async () => { retry!.click(); });
    expect(host.querySelector('[role="alert"]')).toBeNull();
    expect(host.textContent).toContain('Terminal de login aberto');
    act(() => root.unmount());
  });

  it('uses the login command supplied by a provider outside the built-in account table', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () => {
      root.render(<AccountsManager adapterId="custom-cli" adapterLabel="Custom CLI"
        loginCommand="custom-cli auth login"
        authStatus={{ adapterId: 'custom-cli', state: 'missing', detail: 'Entre na ferramenta.' }} />);
    });
    const login = host.querySelector<HTMLButtonElement>('[data-testid="acct-login-cta"]');
    expect(login).toBeTruthy();
    await act(async () => { login!.click(); });
    expect(openCliLoginTerminal).toHaveBeenCalledWith(expect.objectContaining({
      adapterId: 'custom-cli', command: 'custom-cli auth login',
    }));
    act(() => root.unmount());
  });

  it('cancelar a escolha de site do Kimi não pinta erro de login (F-354)', async () => {
    vi.mocked(openCliLoginTerminal).mockResolvedValueOnce({
      ok: false,
      error: 'Login cancelado.',
      cancelled: true,
    });
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () => {
      root.render(
        <AccountsManager
          adapterId="kimi"
          adapterLabel="Kimi"
          loginCommand="kimi login --region global"
          authStatus={{
            adapterId: 'kimi',
            state: 'missing',
            detail: 'Entre na ferramenta.',
          }}
        />,
      );
    });
    const login = host.querySelector<HTMLButtonElement>(
      '[data-testid="acct-login-cta"]',
    );
    expect(login).toBeTruthy();
    await act(async () => {
      login!.click();
    });
    expect(host.querySelector('[role="alert"]')).toBeNull();
    expect(host.textContent).not.toContain('Login cancelado');
    expect(host.textContent).not.toContain('Tentar abrir novamente');
    act(() => root.unmount());
  });

  it('sem sessão viva não oferece Salvar conta logada e pede login da CLI', async () => {
    Object.defineProperty(window, 'nexus', {
      configurable: true,
      value: {
        providers: {
          authStatus: vi.fn(async () => [
            {
              adapterId: 'claude',
              state: 'missing',
              detail:
                'identidade Claude (dev@example.com) sem sessão viva — rode `claude auth login`',
            },
          ]),
        },
        accounts: {
          supportsSnapshot: vi.fn(async () => ({ ok: true, supported: true })),
        },
      },
    });
    const { host, root } = mount();
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(host.textContent).toContain('precisa login');
    expect(host.textContent).toMatch(/conectar minha conta/i);
    expect(host.textContent).toContain('O app Claude no Dock não conta');
    expect(host.textContent).not.toMatch(/salvar conta logada/i);
    expect(host.textContent).not.toMatch(/entrar com nova conta/i);
    expect(host.textContent).not.toMatch(/fazer login agora/i);
    expect(host.textContent).not.toContain('sessão do CLI');
    expect(host.textContent).not.toContain('Sessão nativa');
    expect(host.textContent).not.toMatch(/nenhuma conta reserva/i);
    expect(host.textContent).not.toMatch(/multi-conta/i);
    expect(host.querySelectorAll('[data-testid="acct-login-cta"]')).toHaveLength(1);
    act(() => root.unmount());
  });

  it('com vault e CLI deslogada lista contas salvas sem fingir Em uso', async () => {
    Object.defineProperty(window, 'nexus', {
      configurable: true,
      value: {
        providers: {
          authStatus: vi.fn(async () => [
            { adapterId: 'claude', state: 'missing', detail: 'sem sessão viva' },
          ]),
        },
        accounts: {
          supportsSnapshot: vi.fn(async () => ({ ok: true, supported: true })),
        },
      },
    });
    useAccountStore.setState({
      accounts: [
        account(),
        account({
          id: 'acct-2',
          label: 'Pessoal',
          active: false,
          email: 'home@example.com',
        }),
      ],
    });
    const { host, root } = mount();
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(host.textContent).toMatch(/contas salvas/i);
    expect(host.textContent).toContain('Trabalho');
    expect(host.textContent).toContain('Pessoal');
    expect(host.textContent).not.toContain('Em uso');
    expect(host.textContent).not.toContain('próximo terminal');
    expect(host.textContent).toMatch(/conectar minha conta/i);
    act(() => root.unmount());
  });

  it('no clique anuncia Abrindo terminal… e não some da tela', async () => {
    Object.defineProperty(window, 'nexus', {
      configurable: true,
      value: {
        providers: {
          authStatus: vi.fn(async () => [
            { adapterId: 'claude', state: 'missing', detail: 'precisa login' },
          ]),
        },
        accounts: {
          supportsSnapshot: vi.fn(async () => ({ ok: true, supported: false })),
        },
      },
    });
    let release: ((value: { ok: true; paneId: string }) => void) | undefined;
    vi.mocked(openCliLoginTerminal).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const { host, root } = mount();
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    const cta = host.querySelector<HTMLButtonElement>(
      '[data-testid="acct-login-cta"]',
    );
    expect(cta).toBeTruthy();
    await act(async () => {
      cta!.click();
      await Promise.resolve();
    });

    expect(host.textContent).toMatch(/abrindo (o )?terminal/i);
    expect(host.textContent).toMatch(/Abrindo terminal…/);
    expect(useAccountStore.getState().addActiveSession).toBeDefined();

    await act(async () => {
      release?.({ ok: true, paneId: 'pane-login' });
      await Promise.resolve();
    });
    act(() => root.unmount());
  });

  it('guarda a conta atual ANTES de abrir o login (bug das 2 contas)', async () => {
    const addActiveSession = vi.fn(async () => ({ ok: true, id: 'acct-live', email: 'dev@example.com' }));
    useAccountStore.setState({
      accounts: [
        account({ label: 'Outra', email: 'other@example.com', active: true }),
      ],
      addActiveSession,
    } as never);

    const { host, root } = mount();
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    await act(async () => {
      host.querySelector<HTMLButtonElement>('[data-testid="acct-add-account"]')!.click();
    });
    await act(async () => {
      host.querySelector<HTMLButtonElement>('[data-testid="acct-add-account-login"]')!.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    // A sessão viva entrou no vault antes de a CLI poder sobrescrevê-la, e o
    // baseline saiu junto: é contra ele que o login novo será provado.
    expect(addActiveSession).toHaveBeenCalledWith('claude', 'dev@example.com');
    expect(loginTerminal.baseline).toMatchObject({
      adapterId: 'claude',
      state: 'ok',
    });
    act(() => root.unmount());
  });

  it('preserva o token atual antes do segundo login mesmo quando o e-mail já está no vault', async () => {
    const addActiveSession = vi.fn(async () => ({ ok: true, id: 'acct-1' }));
    useAccountStore.setState({
      // A sessão viva (dev@example.com) já é esta linha salva.
      accounts: [account({ label: 'Trabalho', email: 'dev@example.com' })],
      addActiveSession,
    } as never);

    const { host, root } = mount();
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    await act(async () => {
      host.querySelector<HTMLButtonElement>('[data-testid="acct-add-account"]')!.click();
    });
    await act(async () => {
      host.querySelector<HTMLButtonElement>('[data-testid="acct-add-account-login"]')!.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(addActiveSession).toHaveBeenCalledWith('claude', 'dev@example.com');
    expect(openCliLoginTerminal).toHaveBeenCalled();
    act(() => root.unmount());
  });

  it('fechar o terminal sem trocar de sessão NÃO inventa uma conta nova', async () => {
    const addActiveSession = vi.fn(async () => ({ ok: true, id: 'acct-live' }));
    useAccountStore.setState({
      accounts: [account({ label: 'Trabalho', email: 'dev@example.com' })],
      addActiveSession,
    } as never);

    const { host, root } = mount();
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => {
      host.querySelector<HTMLButtonElement>('[data-testid="acct-add-account"]')!.click();
    });
    await act(async () => {
      host.querySelector<HTMLButtonElement>('[data-testid="acct-add-account-login"]')!.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    addActiveSession.mockClear();

    await act(async () => {
      finishLogin({ verified: false, status: null });
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(addActiveSession).not.toHaveBeenCalled();
    expect(host.textContent).toMatch(/não deu para confirmar um login novo/i);
    expect(host.textContent).not.toMatch(/conta .* salva no Nexus/i);
    act(() => root.unmount());
  });

  it.each(['rejected', 'thrown'] as const)('não inicia segundo login se preservar a primeira conta falhar (%s)', async (failure) => {
    const addActiveSession = vi.fn(async () => {
      if (failure === 'thrown') throw new Error('vault unavailable');
      return { ok: false, error: 'vault unavailable' };
    });
    useAccountStore.setState({ accounts: [account()], addActiveSession } as never);
    const { host, root } = mount();
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    vi.mocked(openCliLoginTerminal).mockClear();
    await act(async () => { host.querySelector<HTMLButtonElement>('[data-testid="acct-add-account"]')!.click(); });
    await act(async () => {
      host.querySelector<HTMLButtonElement>('[data-testid="acct-add-account-login"]')!.click();
      await Promise.resolve(); await Promise.resolve();
    });
    expect(openCliLoginTerminal).not.toHaveBeenCalled();
    expect(host.querySelector('[role="alert"]')?.textContent).toMatch(/guardar a conta atual/i);
    expect(useAccountStore.getState().accounts[0].id).toBe('acct-1');
    await act(async () => {
      [...host.querySelectorAll('button')].find((button) => button.textContent === 'Tentar abrir novamente')!.click();
      await Promise.resolve(); await Promise.resolve();
    });
    expect(openCliLoginTerminal).not.toHaveBeenCalled();
    expect(addActiveSession).toHaveBeenCalledTimes(2);
    act(() => root.unmount());
  });

  it('login provado grava a conta nova pelo nome digitado, sem depender de e-mail', async () => {
    const added: string[] = [];
    const addActiveSession = vi.fn(async (_adapterId: string, label: string) => {
      added.push(label);
      return { ok: true, id: 'acct-b' };
    });
    useAccountStore.setState({
      accounts: [account({ label: 'Trabalho' })],
      addActiveSession,
    } as never);
    const onAccountAdded = vi.fn();

    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () => {
      root.render(
        <AccountsManager
          adapterId="codex"
          adapterLabel="Codex"
          loginCommand="codex login"
          authStatus={{ adapterId: 'codex', state: 'ok', detail: 'sessão viva' }}
          onAccountAdded={onAccountAdded}
        />,
      );
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    await act(async () => {
      host.querySelector<HTMLButtonElement>('[data-testid="acct-add-account"]')!.click();
    });
    const nameInput = host.querySelector<HTMLInputElement>(
      '[data-testid="acct-new-name"]',
    );
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype, 'value',
      )?.set;
      setter?.call(nameInput!, 'pessoal');
      nameInput!.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
      host.querySelector<HTMLButtonElement>('[data-testid="acct-add-account-login"]')!.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    added.length = 0;

    // A sonda não expõe e-mail nenhum: só o fingerprint prova a troca.
    await act(async () => {
      finishLogin({
        verified: true,
        status: { adapterId: 'codex', state: 'ok', detail: 'sessão viva' },
      });
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(added).toEqual(['pessoal']);
    expect(onAccountAdded).toHaveBeenCalledWith('acct-b');
    expect(host.textContent).toContain('Conta “pessoal” salva no Nexus');
    act(() => root.unmount());
  });

  it('falha ao gravar a conta nova aparece como erro, não como sucesso', async () => {
    let saved = 0;
    const addActiveSession = vi.fn(async () => {
      if (saved++ === 0) return { ok: true, id: 'acct-1' };
      return { ok: false, error: 'Nenhuma sessão ativa detectada para este provider.' };
    });
    useAccountStore.setState({
      accounts: [account()],
      addActiveSession,
    } as never);
    const onAccountAdded = vi.fn();

    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () => {
      root.render(
        <AccountsManager
          adapterId="claude"
          adapterLabel="Claude"
          onAccountAdded={onAccountAdded}
        />,
      );
    });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    await act(async () => {
      host.querySelector<HTMLButtonElement>('[data-testid="acct-add-account"]')!.click();
    });
    await act(async () => {
      host.querySelector<HTMLButtonElement>('[data-testid="acct-add-account-login"]')!.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    await act(async () => {
      finishLogin({
        verified: true,
        status: { adapterId: 'claude', state: 'ok', detail: 'sessão viva' },
      });
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(host.querySelector('[role="alert"]')?.textContent).toContain(
      'Nenhuma sessão ativa detectada',
    );
    expect(onAccountAdded).not.toHaveBeenCalled();
    act(() => root.unmount());
  });

  it('avisa sessão viva não salva com botão direto de salvar (sem trava)', async () => {
    const { host, root } = mount();
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(host.textContent).toContain('ainda não está salva no Nexus');
    const saveBtn = [...host.querySelectorAll('button')].find((b) =>
      b.textContent === 'Salvar esta conta',
    );
    expect(saveBtn).toBeTruthy();

    const addActiveSession = useAccountStore.getState()
      .addActiveSession as ReturnType<typeof vi.fn>;
    await act(async () => {
      saveBtn!.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(addActiveSession).toHaveBeenCalledWith('claude', 'dev@example.com');
    act(() => root.unmount());
  });

  it('marca qual linha é a sessão logada no CLI agora', async () => {
    useAccountStore.setState({
      accounts: [
        account(),
        account({
          id: 'acct-2',
          label: 'Pessoal',
          active: false,
          email: 'home@example.com',
        }),
      ],
    });

    const { host, root } = mount();
    await act(async () => {
      await Promise.resolve();
    });

    // dev@example.com é a sessão viva → a linha dela carrega o badge.
    const rows = [...host.querySelectorAll('.acct__row')];
    const liveRow = rows.find((r) => r.textContent?.includes('Trabalho'));
    expect(liveRow?.textContent).toContain('sessão do CLI');
    const otherRow = rows.find((r) => r.textContent?.includes('Pessoal'));
    expect(otherRow?.textContent).not.toContain('sessão do CLI');
    act(() => root.unmount());
  });

  it('conta com sessão expirada pede re-login e bloqueia Usar', async () => {
    useAccountStore.setState({
      accounts: [
        account({
          id: 'acct-1',
          label: 'Trabalho',
          active: false,
          needsRelogin: true,
          lastError: 'oauth session expired — sonda de quota',
        }),
      ],
    });

    const { host, root } = mount();
    await act(async () => {
      await Promise.resolve();
    });

    const rows = [...host.querySelectorAll('.acct__row')];
    const row = rows.find((r) => r.textContent?.includes('Trabalho'));
    const warn = row?.querySelector('.acct__warn');
    // O botão ao lado já diz "Entrar novamente": o aviso nomeia o estado, sem
    // travessão nem o erro interno em inglês no tooltip.
    expect(warn?.textContent).toBe('sessão expirada');
    expect(warn?.getAttribute('title')).not.toMatch(/oauth|sonda|—/i);
    expect(row?.getAttribute('data-state')).toBe('warn');
    const relogin = [...(row?.querySelectorAll('button') ?? [])].find((b) =>
      b.textContent?.includes('Entrar novamente'),
    );
    expect(relogin).toBeTruthy();
    expect(relogin?.className).toContain('settings-btn--primary');
    const use = [...(row?.querySelectorAll('button') ?? [])].find(
      (b) => b.textContent === 'Usar',
    );
    expect(use?.disabled).toBe(true);
    expect(use?.title).toContain('entre novamente');
    // Uma ação primária por linha: a recuperação, não o "Usar" bloqueado.
    expect(use?.className).not.toContain('settings-btn--primary');
    act(() => root.unmount());
  });

  it('renders active roster row with explicit actions (not glyph-only)', async () => {
    useAccountStore.setState({
      accounts: [
        account(),
        account({
          id: 'acct-2',
          label: 'Pessoal',
          active: false,
          email: 'home@example.com',
        }),
      ],
    });

    const { host, root } = mount();
    await act(async () => {
      await Promise.resolve();
    });

    expect(host.textContent).toContain('Trabalho');
    expect(host.textContent).toContain('Em uso');
    expect(host.textContent).toContain('Pessoal');
    expect(host.textContent).toContain('Sincronizar');
    expect(host.textContent).toContain('Renomear');
    expect(host.textContent).toContain('Remover');
    expect(host.textContent).toContain('Usar');
    expect(host.querySelector('.acct__mini')).toBeNull();
    act(() => root.unmount());
  });

  it('shows auditable real spend on the exact account row', async () => {
    useAccountStore.setState({ accounts: [account()] });
    useUsageStore.setState({
      snapshot: {
        ...EMPTY_USAGE_SNAPSHOT,
        byAccount: {
          'acct-1': {
            accountId: 'acct-1',
            provider: 'claude',
            costUsd: 1.25,
            inputTokens: 1_000,
            outputTokens: 100,
            cacheReadTokens: 0,
            turns: 3,
            source: 'real',
          },
        },
      },
    });

    const { host, root } = mount();
    await act(async () => {
      await Promise.resolve();
    });

    expect(host.textContent).toContain('US$ 1,25');
    expect(host.textContent).toContain('3 turnos reais');
    act(() => root.unmount());
  });

  it('renames inline instead of window.prompt', async () => {
    const rename = vi.fn(async () => undefined);
    useAccountStore.setState({
      accounts: [account()],
      rename,
      hydrate: vi.fn(async () => undefined),
    } as never);

    const promptSpy = vi.spyOn(window, 'prompt');
    const { host, root } = mount();
    await act(async () => {
      await Promise.resolve();
    });

    const renameBtn = [...host.querySelectorAll('button')].find(
      (b) => b.textContent === 'Renomear',
    );
    expect(renameBtn).toBeTruthy();
    await act(async () => renameBtn!.click());

    const input = host.querySelector<HTMLInputElement>('.acct__rename-input');
    expect(input).toBeTruthy();
    expect(promptSpy).not.toHaveBeenCalled();

    await act(async () => {
      input!.value = 'Escritório';
      input!.dispatchEvent(new Event('input', { bubbles: true }));
    });
    // Controlled input needs React change simulation
    await act(async () => {
      const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value',
      )?.set;
      nativeInputValueSetter?.call(input!, 'Escritório');
      input!.dispatchEvent(new Event('input', { bubbles: true }));
    });

    const save = [...host.querySelectorAll('button')].find(
      (b) => b.textContent === 'Salvar nome',
    );
    expect(save).toBeTruthy();
    act(() => root.unmount());
  });

  it('diferencia limite temporário de cota esgotada na frase de cooldown', async () => {
    useAccountStore.setState({
      accounts: [
        account({
          id: 'acct-rl',
          label: 'Rate Limited',
          active: false,
          onCooldown: true,
          cooldownUntil: Date.now() + 5 * 60 * 1000,
          lastError: '429 too many requests',
        }),
        account({
          id: 'acct-quota',
          label: 'Quota Hit',
          active: false,
          onCooldown: true,
          cooldownUntil: Date.now() + 60 * 60 * 1000,
          lastError: 'insufficient_quota',
        }),
      ],
    });

    const { host, root } = mount();
    await act(async () => {
      await Promise.resolve();
    });

    expect(host.textContent).toContain('limite temporário · volta em');
    expect(host.textContent).toContain('cota esgotada · volta em');
    act(() => root.unmount());
  });

  it('re-autentica conta conhecida quando estava com needsRelogin', async () => {
    const addActiveSession = vi.fn(async () => ({ ok: true, id: 'acct-adm' }));
    useAccountStore.setState({
      accounts: [
        account({
          id: 'acct-adm',
          label: 'Conta Adm',
          email: 'dev@example.com',
          active: false,
          needsRelogin: true,
        }),
      ],
      addActiveSession,
    } as never);

    const { host, root } = mount();
    await act(async () => {
      await Promise.resolve();
    });

    const reloginBtn = [...host.querySelectorAll('button')].find((b) =>
      b.textContent?.includes('Entrar novamente'),
    );
    expect(reloginBtn).toBeTruthy();
    await act(async () => {
      reloginBtn!.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    // A sessão nativa saudável é preservada antes de qualquer login, mesmo
    // que a linha do vault selecionada esteja expirada.
    expect(addActiveSession).toHaveBeenCalledWith('claude', expect.any(String));

    // O token rodou: mesmo e-mail, fingerprint novo — é o único sinal que
    // distingue "reautenticou" de "não fez nada" numa CLI já logada.
    await act(async () => {
      finishLogin({
        verified: true,
        status: {
          adapterId: 'claude',
          state: 'ok',
          detail: 'sessão Claude viva: dev@example.com',
        },
      });
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(addActiveSession).toHaveBeenCalledWith(
      'claude',
      'Conta Adm',
      'acct-adm',
    );
    act(() => root.unmount());
  });

  it('abre o re-login da mesma conta quando o snapshot da sessão viva falha', async () => {
    const addActiveSession = vi.fn(async () => ({
      ok: false,
      error: 'Nenhuma sessão ativa detectada para este provider.',
    }));
    useAccountStore.setState({
      accounts: [
        account({
          id: 'agy-1',
          adapterId: 'agy',
          label: 'retorno',
          email: 'retornoja@gmail.com',
          upstream: 'agy',
          needsRelogin: true,
          active: true,
        }),
      ],
      addActiveSession,
    } as never);
    vi.mocked(window.nexus.providers.authStatus).mockResolvedValue([
      {
        adapterId: 'agy',
        state: 'ok',
        detail: 'sessão AGY local · retornoja@gmail.com',
      },
    ]);
    const { host, root } = mount('agy');
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    vi.mocked(openCliLoginTerminal).mockClear();
    await act(async () => {
      [...host.querySelectorAll('button')]
        .find((b) => b.textContent?.includes('Entrar novamente'))!
        .click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(openCliLoginTerminal).toHaveBeenCalled();
    expect(host.textContent).not.toMatch(/guardar a conta atual/i);
    act(() => root.unmount());
  });

  it('não abre re-login quando a sessão viva é outra conta e não foi guardada', async () => {
    const addActiveSession = vi.fn(async () => ({ ok: false, error: 'vault unavailable' }));
    useAccountStore.setState({
      accounts: [
        account({
          id: 'agy-1',
          adapterId: 'agy',
          label: 'retorno',
          email: 'retornoja@gmail.com',
          upstream: 'agy',
          needsRelogin: true,
        }),
      ],
      addActiveSession,
    } as never);
    vi.mocked(window.nexus.providers.authStatus).mockResolvedValue([
      {
        adapterId: 'agy',
        state: 'ok',
        detail: 'sessão AGY local · other@example.com',
        sessionFingerprint: 'fp-other',
      },
    ]);
    const { host, root } = mount('agy');
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    vi.mocked(openCliLoginTerminal).mockClear();
    await act(async () => {
      [...host.querySelectorAll('button')]
        .find((b) => b.textContent?.includes('Entrar novamente'))!
        .click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(openCliLoginTerminal).not.toHaveBeenCalled();
    expect(host.textContent).toMatch(/guardar a conta atual/i);
    act(() => root.unmount());
  });

  it('does not treat an API key as a native session to preserve during relogin', async () => {
    const addActiveSession = vi.fn(async () => ({ ok: false, error: 'No native login' }));
    useAccountStore.setState({ accounts: [account({ id: 'target', needsRelogin: true })], addActiveSession });
    vi.mocked(window.nexus.providers.authStatus).mockResolvedValue([
      { adapterId: 'claude', state: 'ok', detail: 'API key no cofre' },
    ]);
    const callsBefore = vi.mocked(openCliLoginTerminal).mock.calls.length;
    const { host, root } = mount();
    await act(async () => { await Promise.resolve(); });
    await act(async () => { [...host.querySelectorAll('button')].find(b => b.textContent?.includes('Entrar novamente'))!.click(); });
    expect(vi.mocked(openCliLoginTerminal).mock.calls.length).toBe(callsBefore + 1);
    expect(addActiveSession).not.toHaveBeenCalled();
    act(() => root.unmount());
  });

  it('keeps the targeted account when retrying a login terminal that failed to open', async () => {
    const addActiveSession = vi.fn(async () => ({ ok: true, id: 'target' }));
    useAccountStore.setState({ accounts: [account({ id: 'target', needsRelogin: true })], addActiveSession });
    vi.mocked(openCliLoginTerminal).mockResolvedValueOnce({ ok: false, error: 'PTY unavailable' });
    const { host, root } = mount();
    await act(async () => { await Promise.resolve(); });
    await act(async () => { [...host.querySelectorAll('button')].find(b => b.textContent?.includes('Entrar novamente'))!.click(); });
    await act(async () => { [...host.querySelectorAll('button')].find(b => b.textContent?.includes('Tentar abrir novamente'))!.click(); });
    await act(async () => { finishLogin({ verified: true, status: { adapterId: 'claude', state: 'ok', detail: 'Logged in' } }); });
    expect(addActiveSession).toHaveBeenLastCalledWith('claude', 'Trabalho', 'target');
    act(() => root.unmount());
  });

  it('oferece o cadastro com 1, 2 e 3 contas já salvas — sem teto', async () => {
    useAccountStore.setState({
      accounts: [
        account({ id: 'c1', adapterId: 'codex', label: 'A' }),
        account({ id: 'c2', adapterId: 'codex', label: 'B', active: false }),
        account({ id: 'c3', adapterId: 'codex', label: 'C', active: false }),
      ],
    });
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () => {
      root.render(
        <AccountsManager
          adapterId="codex"
          adapterLabel="Codex"
          loginCommand="codex login"
          authStatus={{ adapterId: 'codex', state: 'ok', detail: 'sessão viva' }}
        />,
      );
    });
    await act(async () => { await Promise.resolve(); });

    expect(host.textContent).toContain('A');
    expect(host.textContent).toContain('B');
    expect(host.textContent).toContain('C');
    expect(
      host.querySelector('[data-testid="acct-add-account"]'),
    ).toBeTruthy();
    act(() => root.unmount());
  });

  it.each([true, false])('completes a native-only login honestly (verified=%s)', async (verified) => {
    const snapshot = vi.mocked(window.nexus.accounts.supportsSnapshot);
    snapshot.mockResolvedValue({ ok: true, supported: true });
    vi.mocked(window.nexus.providers.authStatus).mockResolvedValue([{ adapterId: 'muse', state: 'ok', detail: 'sessão nativa' }]);
    const { host, root } = mount('muse');
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    await act(async () => { host.querySelector<HTMLButtonElement>('[data-testid="acct-add-account"]')!.click(); });
    await act(async () => { host.querySelector<HTMLButtonElement>('[data-testid="acct-add-account-login"]')!.click(); });
    vi.mocked(useAccountStore.getState().addActiveSession).mockClear();
    snapshot.mockResolvedValue({ ok: true, supported: false });
    await act(async () => {
      finishLogin({ verified, status: { adapterId: 'muse', state: 'ok', detail: 'sessão nativa nova' } });
      await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    });
    expect(useAccountStore.getState().addActiveSession).not.toHaveBeenCalled();
    expect(host.textContent).not.toContain('Salvar esta conta');
    expect(host.textContent).not.toContain('salva no Nexus');
    expect(host.querySelector('[role="alert"]')).toBeNull();
    expect(host.textContent).toContain('chave de API');
    if (verified) expect(host.textContent).toContain('Login nativo de muse confirmado');
    else {
      expect(host.textContent).toMatch(/não deu para confirmar um login novo/i);
      expect(host.textContent).not.toContain('Login nativo de muse confirmado');
    }
    act(() => root.unmount());
  });

  it('refreshes snapshot capability when the auth source changes while remaining connected', async () => {
    const snapshot = vi.mocked(window.nexus.accounts.supportsSnapshot);
    snapshot.mockResolvedValue({ ok: true, supported: true });
    const host = document.createElement('div'); document.body.appendChild(host);
    const root = createRoot(host);
    const render = (detail: string) => root.render(<AccountsManager adapterId="muse" adapterLabel="Muse" authStatus={{ adapterId: 'muse', state: 'ok', detail }} />);
    await act(async () => { render('sessão portátil'); });
    expect(host.textContent).toContain('Salvar esta conta');
    snapshot.mockResolvedValue({ ok: true, supported: false });
    await act(async () => { render('sessão nativa sem snapshot'); });
    expect(host.textContent).not.toContain('Salvar esta conta');
    expect(host.textContent).toContain('A sessão continua na CLI desta máquina');
    expect(host.textContent).not.toContain('Keychain');
    act(() => root.unmount());
  });

  it('CLI sem snapshot diz a verdade em vez de prometer contas paralelas', async () => {
    Object.defineProperty(window, 'nexus', {
      configurable: true,
      value: {
        providers: {
          authStatus: vi.fn(async () => [
            { adapterId: 'muse', state: 'ok', detail: 'sessão nativa sem e-mail' },
          ]),
        },
        accounts: {
          supportsSnapshot: vi.fn(async () => ({ ok: true, supported: false })),
        },
      },
    });
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () => {
      root.render(
        <AccountsManager adapterId="muse" adapterLabel="Muse" loginCommand="muse login" />,
      );
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(host.textContent).toContain('A sessão continua na CLI desta máquina');
    expect(host.textContent).not.toContain('Salvar esta conta');
    expect(host.textContent).toContain('Adicionar chave de API');
    await act(async () => {
      host.querySelector<HTMLButtonElement>('[data-testid="acct-add-account"]')!.click();
    });
    expect(host.textContent).toMatch(/troca a sessão da ferramenta/i);
    expect(host.textContent).toMatch(/use API key/i);
    act(() => root.unmount());
  });
});

// F-1293: recusa do IPC em remove/rename não pode virar anúncio de sucesso.
describe('F-1293 — remove/rename recusados mostram erro, não sucesso', () => {
  beforeEach(() => {
    useAccountStore.setState({
      accounts: [account()],
      quota: [],
      hydrate: vi.fn(async () => undefined),
    } as never);
    useConfirmStore.setState({ pending: null, queue: [] });
    useUsageStore.setState({ snapshot: EMPTY_USAGE_SNAPSHOT });
    Object.defineProperty(window, 'nexus', {
      configurable: true,
      value: {
        providers: {
          authStatus: vi.fn(async () => [
            { adapterId: 'claude', state: 'ok', detail: 'ok' },
          ]),
        },
        accounts: {
          supportsSnapshot: vi.fn(async () => ({ ok: true, supported: true })),
        },
      },
    });
  });

  afterEach(() => {
    Reflect.deleteProperty(window, 'nexus');
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  async function flush(): Promise<void> {
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  it('remove ok:false mantém a conta e mostra o erro, sem "Conta removida."', async () => {
    const remove = vi.fn(async () => ({
      ok: false as const,
      error: 'vault unavailable',
    }));
    useAccountStore.setState({ remove } as never);
    const { host, root } = mount();
    await flush();

    const rm = [...host.querySelectorAll('button')].find((b) =>
      (b.textContent ?? '').includes('Remover'),
    )!;
    expect(rm).toBeTruthy();
    await act(async () => rm.click());

    // Confirma o diálogo de perigo (o host do diálogo não está montado aqui).
    expect(useConfirmStore.getState().pending).toBeTruthy();
    await act(async () => useConfirmStore.getState().pending!.resolve(true));
    await flush();

    expect(remove).toHaveBeenCalledWith('acct-1');
    expect(useAccountStore.getState().accounts).toHaveLength(1);
    expect(host.textContent).toContain('vault unavailable');
    expect(host.textContent).not.toContain('Conta removida.');
    act(() => root.unmount());
  });

  it('rename ok:false mantém o editor aberto e mostra o erro, sem "Nome atualizado."', async () => {
    const rename = vi.fn(async () => ({
      ok: false as const,
      error: 'label too long',
    }));
    useAccountStore.setState({ rename } as never);
    const { host, root } = mount();
    await flush();

    const renameBtn = [...host.querySelectorAll('button')].find(
      (b) => b.textContent === 'Renomear',
    )!;
    await act(async () => renameBtn.click());
    const input = host.querySelector<HTMLInputElement>('.acct__rename-input');
    expect(input).toBeTruthy();
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value',
      )?.set;
      setter?.call(input!, 'Nome de 129 caracteres '.repeat(6).slice(0, 129));
      input!.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const save = [...host.querySelectorAll('button')].find(
      (b) => b.textContent === 'Salvar nome',
    )!;
    await act(async () => save.click());
    await flush();

    expect(rename).toHaveBeenCalled();
    expect(host.querySelector('.acct__rename-input')).toBeTruthy();
    expect(host.textContent).toContain('label too long');
    expect(host.textContent).not.toContain('Nome atualizado.');
    act(() => root.unmount());
  });
});
