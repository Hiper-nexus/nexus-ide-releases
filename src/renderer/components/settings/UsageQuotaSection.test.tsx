/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProviderQuotaEntry, QuotaFleetSnapshot } from '../../../shared/quota-types';
import { useAccountStore } from '../../state/account-store';
import { useQuotaStore } from '../../state/quota-store';
import { useToastStore } from '../../state/toast-store';
import { UsageQuotaSection } from './UsageQuotaSection';
import { openCliLoginTerminal } from './cli-login-terminal';

vi.mock('./cli-login-terminal', () => ({
  openCliLoginTerminal: vi.fn(async () => ({ ok: true, paneId: 'login-pane' })),
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

const sampleEntries: ProviderQuotaEntry[] = [
  {
    id: 'claude',
    adapterId: 'claude',
    label: 'Claude · CLI nativo',
    installed: true,
    onCooldown: false,
    windows: [
      {
        kind: 'hours',
        label: '5 Horas',
        usedRatio: 0.42,
        source: 'provider-api',
        confidence: 'high',
        remainingLabel: '3h 12m',
      },
      {
        kind: 'weekly',
        label: 'Semanal',
        usedRatio: 0.15,
        source: 'provider-api',
        confidence: 'high',
      },
    ],
    updatedAt: 1723630000000,
  },
  {
    id: 'codex:acc-1',
    adapterId: 'codex',
    accountId: 'acc-1',
    label: 'Codex · Plus',
    installed: true,
    onCooldown: true,
    cooldownKind: 'rate-limit',
    windows: [
      {
        kind: 'hours',
        label: '5 Horas',
        usedRatio: 0.95,
        source: 'limit-hit',
        confidence: 'high',
        remainingLabel: 'cooldown 45m',
      },
      {
        kind: 'weekly',
        label: 'Semanal',
        usedRatio: null,
        source: 'unknown',
        confidence: 'low',
      },
    ],
    updatedAt: 1723630000000,
  },
  {
    id: 'opencode',
    adapterId: 'opencode',
    label: 'OpenCode',
    installed: false,
    onCooldown: false,
    windows: [
      {
        kind: 'hours',
        label: '5 Horas',
        usedRatio: null,
        source: 'unknown',
        confidence: 'low',
      },
      {
        kind: 'weekly',
        label: 'Semanal',
        usedRatio: null,
        source: 'unknown',
        confidence: 'low',
      },
    ],
    updatedAt: 1723630000000,
  },
];

const sampleSnapshot: QuotaFleetSnapshot = {
  updatedAt: 1723630000000,
  entries: sampleEntries,
  worstUsedRatio: 0.95,
  highUsageCount: 1,
  unknownCount: 1,
};

function mount(): { host: HTMLDivElement; root: Root } {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => root.render(<UsageQuotaSection />));
  return { host, root };
}

describe('UsageQuotaSection', () => {
  beforeEach(() => {
    vi.mocked(openCliLoginTerminal).mockClear();
    useToastStore.setState({ toasts: [] });
    useQuotaStore.getState().reset();
    useAccountStore.setState({
      accounts: [
        {
          id: 'acc-1',
          adapterId: 'codex',
          label: 'Plus',
          mode: 'subscription',
          upstream: 'codex',
          email: 'user@example.com',
          active: true,
          createdAt: 1723630000000,
          onCooldown: true,
          needsRelogin: false,
          hasCredential: true,
        },
      ],
    });
    Object.defineProperty(window, 'nexus', {
      configurable: true,
      value: {
        quota: {
          snapshot: vi.fn(async () => sampleSnapshot),
          refresh: vi.fn(async () => sampleSnapshot),
        },
      },
    });
  });

  afterEach(() => {
    useQuotaStore.getState().reset();
    Reflect.deleteProperty(window, 'nexus');
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });


  it('opens MiMo quota connection only on its explicit button', async () => {
    const connectMimo = vi.fn(async () => ({ ok: true, message: 'Cota conectada' }));
    Object.assign(window.nexus.quota, { connectMimo });
    vi.mocked(window.nexus.quota.refresh).mockResolvedValue({ ...sampleSnapshot, entries: [{ ...sampleEntries[0], id: 'mimo-code:mine', adapterId: 'mimo-code', accountId: 'mine', label: 'MiMo Code' }] });
    const { host, root } = mount();
    await act(async () => { await Promise.resolve(); });
    expect(connectMimo).not.toHaveBeenCalled();
    const button = [...host.querySelectorAll('button')].find(button => button.textContent === 'Conectar cota');
    expect(button).toBeDefined();
    await act(async () => { button!.click(); });
    expect(connectMimo).toHaveBeenCalledWith('mine');
    act(() => root.unmount());
  });

  it('renders header, description, and status overview counters', async () => {
    const { host, root } = mount();
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(host.textContent).toContain('Uso e cotas');
    expect(host.textContent).toContain('3 conexões e contas');
    expect(host.textContent).toContain('1 com uso elevado');
    expect(host.textContent).toContain('1 sem cota informada');

    act(() => root.unmount());
  });

  it('renders provider entries with labels, email, cooldown, and badges', async () => {
    const { host, root } = mount();
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(host.textContent).toContain('Conexão atual');
    expect(host.textContent).toContain('Codex · Plus');
    expect(host.textContent).toContain('user@example.com');
    expect(host.textContent).toContain('Não instalada');
    expect(host.textContent).toContain('Pausa temporária');

    // Windows percentages and unknown "—"
    expect(host.textContent).toContain('42%');
    expect(host.textContent).toContain('95%');
    expect(host.textContent).toContain('Não informado');

    act(() => root.unmount());
  });

  it('renders progress bar attributes correctly for known vs unknown windows', async () => {
    const { host, root } = mount();
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const progressbars = host.querySelectorAll('[role="progressbar"]');
    expect(progressbars.length).toBeGreaterThanOrEqual(3);

    const first = progressbars[0];
    expect(first.getAttribute('aria-valuenow')).toBe('95');
    expect(first.getAttribute('aria-valuemin')).toBe('0');
    expect(first.getAttribute('aria-valuemax')).toBe('100');
    const values = [...progressbars].map((bar) => bar.getAttribute('aria-valuenow'));
    expect(values).toContain('42');

    act(() => root.unmount());
  });

  it('renders empty state when no entries exist and status is ready', async () => {
    Object.defineProperty(window, 'nexus', {
      configurable: true,
      value: {
        quota: {
          snapshot: vi.fn(async () => ({
            updatedAt: 1723630000000,
            entries: [],
            worstUsedRatio: null,
            highUsageCount: 0,
            unknownCount: 0,
          })),
          refresh: vi.fn(async () => ({
            updatedAt: 1723630000000,
            entries: [],
            worstUsedRatio: null,
            highUsageCount: 0,
            unknownCount: 0,
          })),
        },
      },
    });

    const { host, root } = mount();
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(host.textContent).toContain('Nenhuma cota disponível ainda');
    expect(host.textContent).toContain('Ver conexões de IA');

    act(() => root.unmount());
  });

  it('renders error message when store status is error', async () => {
    Object.defineProperty(window, 'nexus', {
      configurable: true,
      value: {
        quota: {
          snapshot: vi.fn(async () => {
            throw new Error('Falha de conexão IPC');
          }),
          refresh: vi.fn(async () => {
            throw new Error('Falha de conexão IPC');
          }),
        },
      },
    });

    const { host, root } = mount();
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(host.textContent).toContain('Não foi possível carregar as cotas.');
    expect(host.textContent).not.toContain('Falha de conexão IPC');

    act(() => root.unmount());
  });

  it('hides old percentages after a failed refresh and restores them on retry', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { host, root } = mount();
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(host.querySelectorAll('[role="progressbar"]').length).toBeGreaterThan(0);
    vi.mocked(window.nexus.quota.refresh).mockRejectedValueOnce(new Error('fixture-only'));
    await act(async () => { host.querySelector<HTMLButtonElement>('.quota-panel__refresh')!.click(); });
    expect(host.querySelectorAll('[role="progressbar"]')).toHaveLength(0);
    expect(host.textContent).toContain('Não foi possível carregar as cotas.');
    await act(async () => { host.querySelector<HTMLButtonElement>('.quota-panel__refresh')!.click(); });
    expect(host.querySelectorAll('[role="progressbar"]').length).toBeGreaterThan(0);
    act(() => root.unmount());
  });

  it('identifies the quota supplier separately from the CLI owner', async () => {
    const routed = { ...sampleSnapshot, entries: [{ ...sampleEntries[0], usageProviderId: 'glm' }] };
    vi.mocked(window.nexus.quota.refresh).mockResolvedValue(routed);
    const { host, root } = mount();
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(host.textContent).toContain('Claude');
    expect(host.textContent).toContain('GLM');
    expect(host.querySelector('[data-adapter="claude"]')).not.toBeNull();
    act(() => root.unmount());
  });

  it('não esconde a sessão nativa por inferir identidade apenas pelo e-mail', async () => {
    useAccountStore.setState({
      accounts: [
        {
          id: 'acc-1',
          adapterId: 'codex',
          label: 'Plus',
          mode: 'subscription',
          upstream: 'codex',
          email: 'user@example.com',
          active: true,
          createdAt: 1723630000000,
          onCooldown: true,
          needsRelogin: false,
          hasCredential: true,
        },
        {
          id: 'acc-2',
          adapterId: 'claude',
          label: 'Trabalho',
          mode: 'subscription',
          upstream: 'anthropic',
          email: 'dev@example.com',
          active: true,
          createdAt: 1723630000000,
          onCooldown: false,
          needsRelogin: false,
          hasCredential: true,
        },
      ],
    });
    // Sonda de login: a sessão Claude viva É a conta dev@example.com do vault.
    Object.defineProperty(window, 'nexus', {
      configurable: true,
      value: {
        quota: {
          snapshot: vi.fn(async () => sampleSnapshot),
          refresh: vi.fn(async () => sampleSnapshot),
        },
        providers: {
          authStatus: vi.fn(async () => [
            {
              adapterId: 'claude',
              state: 'ok',
              detail: 'sessão Claude viva: dev@example.com',
            },
          ]),
        },
      },
    });

    const { host, root } = mount();
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(host.querySelector('[data-adapter="claude"]')).not.toBeNull();
    expect(host.querySelectorAll('.quota-entry').length).toBe(3);
    expect(host.textContent).toContain('3 conexões e contas');
    expect(window.nexus.providers.authStatus).not.toHaveBeenCalled();
    act(() => root.unmount());
  });

  it('conta com sessão expirada ganha badge na linha de cota', async () => {
    useAccountStore.setState({
      accounts: [
        {
          id: 'acc-1',
          adapterId: 'codex',
          label: 'Plus',
          mode: 'subscription',
          upstream: 'codex',
          email: 'user@example.com',
          active: true,
          createdAt: 1723630000000,
          onCooldown: false,
          needsRelogin: true,
          hasCredential: true,
        },
      ],
    });

    const { host, root } = mount();
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(host.textContent).toContain('Entrar novamente');
    act(() => root.unmount());
  });

  it('reabre o login da conta salva pelo botão da linha de cota', async () => {
    useAccountStore.setState({
      accounts: [
        {
          id: 'acc-1',
          adapterId: 'codex',
          label: 'Plus',
          mode: 'subscription',
          upstream: 'codex',
          email: 'user@example.com',
          active: true,
          createdAt: 1723630000000,
          onCooldown: false,
          needsRelogin: true,
          hasCredential: true,
        },
      ],
    });
    Object.defineProperty(window, 'nexus', {
      configurable: true,
      value: {
        quota: {
          snapshot: vi.fn(async () => sampleSnapshot),
          refresh: vi.fn(async () => sampleSnapshot),
        },
        providers: {
          authStatus: vi.fn(async () => [
            { adapterId: 'codex', state: 'ok', detail: 'sessão Codex' },
          ]),
        },
      },
    });

    const { host, root } = mount();
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const button = host.querySelector<HTMLButtonElement>(
      '[data-adapter="codex"] button',
    );
    expect(button?.textContent).toContain('Entrar novamente');
    await act(async () => {
      button?.click();
      await Promise.resolve();
    });

    expect(openCliLoginTerminal).toHaveBeenCalledWith(
      expect.objectContaining({
        command: 'codex login',
        adapterId: 'codex',
        adapterLabel: 'Plus',
      }),
    );
    act(() => root.unmount());
  });

  async function openSavedAccountLogin(preserveOk = true, supported = true) {
    useAccountStore.setState({ accounts: useAccountStore.getState().accounts.map(
      (account) => ({ ...account, needsRelogin: true }),
    ) });
    const events: string[] = [];
    const addActiveSession = vi.fn(async (_adapter: string, _label: string, target?: string) => {
      events.push(target ? 'save-target' : 'preserve');
      return target || preserveOk ? { ok: true, id: target ?? 'native-account' }
        : { ok: false, error: 'Não foi possível preservar a sessão atual.' };
    });
    Object.defineProperty(window, 'nexus', { configurable: true, value: {
      ...window.nexus,
      providers: { authStatus: vi.fn(async () => [{
        adapterId: 'codex', state: 'ok', detail: 'Sessão: sibling@example.test', sessionFingerprint: 'sibling',
      }]) },
      accounts: {
        supportsSnapshot: vi.fn(async () => ({ ok: true, supported })),
        addActiveSession,
        list: vi.fn(async () => useAccountStore.getState().accounts),
        quota: vi.fn(async () => []),
      },
    } });
    vi.mocked(openCliLoginTerminal).mockImplementation(async () => {
      events.push('open');
      return { ok: true, paneId: 'login-pane' };
    });
    const mounted = mount();
    await act(async () => { await Promise.resolve(); });
    await act(async () => { mounted.host.querySelector<HTMLButtonElement>('[data-adapter="codex"] button')!.click(); });
    return { ...mounted, events, addActiveSession };
  }

  it('preserves the native sibling before login and saves only the selected account after proof', async () => {
    const { root, events, addActiveSession } = await openSavedAccountLogin();
    expect(events).toEqual(['preserve', 'open']);
    const input = vi.mocked(openCliLoginTerminal).mock.calls[0][0];
    expect(input.reauthenticate).toBe(true);
    vi.mocked(window.nexus.quota.refresh).mockClear();
    await act(async () => { await input.onFinished!({ verified: true, status: null }); });
    expect(addActiveSession).toHaveBeenLastCalledWith('codex', 'Plus', 'acc-1');
    expect(window.nexus.accounts.list).toHaveBeenCalled();
    expect(window.nexus.quota.refresh).toHaveBeenCalled();
    act(() => root.unmount());
  });

  it('does not save the selected account when login is closed without proof', async () => {
    const { root, addActiveSession } = await openSavedAccountLogin();
    await act(async () => { await vi.mocked(openCliLoginTerminal).mock.calls[0][0].onFinished!({ verified: false, status: null }); });
    expect(addActiveSession.mock.calls.filter((call) => call[2])).toEqual([]);
    expect(useToastStore.getState().toasts.some((toast) => /confirmar/i.test(toast.detail ?? ''))).toBe(true);
    act(() => root.unmount());
  });

  it.each([[false, true], [true, false]])('does not replace native login when preservation fails (save=%s snapshot=%s)', async (preserveOk, supported) => {
    const { root } = await openSavedAccountLogin(preserveOk, supported);
    expect(openCliLoginTerminal).not.toHaveBeenCalled();
    expect(useToastStore.getState().toasts.some((toast) => toast.kind === 'error')).toBe(true);
    act(() => root.unmount());
  });

  it('reports rejected target identity instead of claiming login was saved', async () => {
    const { root, addActiveSession } = await openSavedAccountLogin();
    addActiveSession.mockResolvedValueOnce({ ok: false, error: 'O login pertence a outra conta.' });
    await act(async () => { await vi.mocked(openCliLoginTerminal).mock.calls[0][0].onFinished!({ verified: true, status: null }); });
    expect(useToastStore.getState().toasts.some((toast) => toast.kind === 'error' && /outra conta/.test(toast.detail ?? ''))).toBe(true);
    expect(useToastStore.getState().toasts.some((toast) => toast.kind === 'success')).toBe(false);
    act(() => root.unmount());
  });

  it('mantém o badge quando a cota não pertence a uma conta salva', async () => {
    useAccountStore.setState({
      accounts: [
        {
          id: 'acc-1',
          adapterId: 'codex',
          label: 'Plus',
          mode: 'subscription',
          upstream: 'codex',
          email: 'user@example.com',
          active: true,
          createdAt: 1723630000000,
          onCooldown: false,
          needsRelogin: true,
          hasCredential: true,
        },
      ],
    });
    const nativeEntry = { ...sampleEntries[0], id: 'native-expired' };
    vi.mocked(window.nexus.quota.snapshot).mockResolvedValue({
      ...sampleSnapshot,
      entries: [nativeEntry],
    });

    const { host, root } = mount();
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(host.querySelector('[data-adapter="claude"] button')).toBeNull();
    expect(host.querySelector('.quota-entry__badge')?.textContent).toContain(
      'Cota informada',
    );
    act(() => root.unmount());
  });

  it('não renderiza botão para conta sem necessidade de novo login', async () => {
    const { host, root } = mount();
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(host.querySelector('[data-adapter="codex"] button')).toBeNull();
    act(() => root.unmount());
  });

  it('mantém a linha "CLI nativo" quando a sessão viva NÃO é conta salva', async () => {
    useAccountStore.setState({
      accounts: [
        {
          id: 'acc-1',
          adapterId: 'codex',
          label: 'Plus',
          mode: 'subscription',
          upstream: 'codex',
          email: 'user@example.com',
          active: true,
          createdAt: 1723630000000,
          onCooldown: true,
          needsRelogin: false,
          hasCredential: true,
        },
      ],
    });
    Object.defineProperty(window, 'nexus', {
      configurable: true,
      value: {
        quota: {
          snapshot: vi.fn(async () => sampleSnapshot),
          refresh: vi.fn(async () => sampleSnapshot),
        },
        providers: {
          authStatus: vi.fn(async () => [
            {
              adapterId: 'claude',
              state: 'ok',
              detail: 'sessão Claude viva: stranger@example.com',
            },
          ]),
        },
      },
    });

    const { host, root } = mount();
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(host.textContent).toContain('Conexão atual');
    act(() => root.unmount());
  });

  it('triggers refresh when clicking the refresh button', async () => {
    const refreshSpy = vi.fn(async () => sampleSnapshot);
    Object.defineProperty(window, 'nexus', {
      configurable: true,
      value: {
        quota: {
          snapshot: vi.fn(async () => sampleSnapshot),
          refresh: refreshSpy,
        },
      },
    });

    const { host, root } = mount();
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const btn = host.querySelector<HTMLButtonElement>('.quota-panel__refresh');
    expect(btn).not.toBeNull();
    expect(btn?.disabled).toBe(false);

    await act(async () => {
      btn?.click();
      await Promise.resolve();
    });

    expect(refreshSpy).toHaveBeenCalled();
    act(() => root.unmount());
  });
});
