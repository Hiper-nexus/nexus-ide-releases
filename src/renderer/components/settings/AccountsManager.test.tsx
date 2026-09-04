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

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

/** Terminal de login mockado: captura o onFinished para dispará-lo no teste. */
const loginTerminal = vi.hoisted(() => ({
  finish: null as null | (() => void),
}));
vi.mock('./cli-login-terminal', () => ({
  openCliLoginTerminal: vi.fn(
    async (input: { onFinished?: () => void }) => {
      loginTerminal.finish = input.onFinished ?? null;
      return { ok: true as const, paneId: 'pane-login' };
    },
  ),
}));

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

  it('shows implicit native session when vault is empty', async () => {
    const { host, root } = mount();
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(host.textContent).toContain('Sessão nativa de claude');
    expect(host.textContent).toContain('conectado');
    expect(host.textContent).toContain('API key');
    expect(host.textContent).toMatch(/entrar com outra conta/i);
    expect(host.textContent).toMatch(/salvar conta logada/i);
    expect(host.textContent).not.toMatch(/abrir login da CLI/i);
    expect(host.textContent).not.toMatch(/1 ·/i);
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
    expect(host.textContent).toMatch(/abrir login da CLI/i);
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
    expect(host.textContent).toMatch(/abrir login da CLI/i);
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

  it('auto-salva a conta nova quando o terminal de login fecha (bug das 2 contas)', async () => {
    const addActiveSession = vi.fn(async () => ({ ok: true, email: 'dev@example.com' }));
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

    const enterBtn = [...host.querySelectorAll('button')].find((b) =>
      b.textContent?.includes('Entrar com outra conta'),
    );
    expect(enterBtn).toBeTruthy();
    await act(async () => {
      enterBtn!.click();
      await Promise.resolve();
    });
    expect(loginTerminal.finish).not.toBeNull();

    // Terminal de login fechou → a sessão viva (dev@example.com) não está no
    // vault → entra sozinha, sem o operador achar o botão "salvar".
    await act(async () => {
      loginTerminal.finish!();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(addActiveSession).toHaveBeenCalledWith('claude', 'dev@example.com');
    act(() => root.unmount());
  });

  it('não auto-salva quando a sessão viva já é conta conhecida', async () => {
    const addActiveSession = vi.fn(async () => ({ ok: true }));
    useAccountStore.setState({
      accounts: [account()],
      addActiveSession,
    } as never);

    const { host, root } = mount();
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const enterBtn = [...host.querySelectorAll('button')].find((b) =>
      b.textContent?.includes('Entrar com outra conta'),
    );
    await act(async () => {
      enterBtn!.click();
      await Promise.resolve();
    });
    await act(async () => {
      loginTerminal.finish!();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(addActiveSession).not.toHaveBeenCalled();
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
        }),
      ],
    });

    const { host, root } = mount();
    await act(async () => {
      await Promise.resolve();
    });

    const rows = [...host.querySelectorAll('.acct__row')];
    const row = rows.find((r) => r.textContent?.includes('Trabalho'));
    expect(row?.textContent).toContain('sessão expirada — entre novamente');
    expect(row?.getAttribute('data-state')).toBe('warn');
    const relogin = [...(row?.querySelectorAll('button') ?? [])].find((b) =>
      b.textContent?.includes('Entrar novamente'),
    );
    expect(relogin).toBeTruthy();
    const use = [...(row?.querySelectorAll('button') ?? [])].find(
      (b) => b.textContent === 'Usar',
    );
    expect(use?.disabled).toBe(true);
    expect(use?.title).toContain('entre novamente');
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
});
