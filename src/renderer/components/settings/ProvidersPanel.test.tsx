/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProviderSettingsInfo } from '../../../shared/provider-settings-types';
import { useAccountStore } from '../../state/account-store';
import { useProviderStore } from '../../state/provider-store';
import { ProvidersPanel } from './ProvidersPanel';

const loginTerminal = vi.hoisted(() => ({
  openCliLoginTerminal: vi.fn(async () => ({
    ok: true as const,
    paneId: 'pane-login',
  })),
}));
vi.mock('./cli-login-terminal', () => loginTerminal);

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

function provider(
  adapterId: string,
  label: string,
  opts: Partial<ProviderSettingsInfo> = {},
): ProviderSettingsInfo {
  return {
    adapterId,
    label,
    icon: '◆',
    kind: 'cli-pty',
    enabled: true,
    installed: true,
    canAutoInstall: false,
    binPath: '',
    detectedBin: adapterId,
    defaultModel: `${adapterId}-default`,
    models: [`${adapterId}-default`, `${adapterId}-alt`],
    extraArgs: [],
    keyEnvVar: null,
    hasKey: false,
    keyMasked: null,
    authMethod: 'cli',
    secureStorageAvailable: true,
    authStrategy: 'subscription',
    upstream: 'anthropic',
    routable: false,
    upstreams: [],
    permissionMode: '',
    permissionModes: [],
    effort: '',
    efforts: [],
    verbose: false,
    supportsVerbose: false,
    customModels: [],
    ...opts,
  };
}

function mount(): { host: HTMLDivElement; root: Root } {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => root.render(<ProvidersPanel />));
  return { host, root };
}

describe('ProvidersPanel hub', () => {
  it('helps a first-time user find an AI without installing anything automatically', async () => {
    useProviderStore.setState({ providers: [provider('claude', 'Claude', { installed: false, canAutoInstall: true })] });
    const { host, root } = mount();
    expect(host.textContent).toContain('Nenhuma ferramenta de IA encontrada neste computador');
    const action = [...host.querySelectorAll('button')].find(button => button.textContent === 'Ver ferramentas para instalar');
    expect(action).toBeDefined();
    await act(async () => action!.click());
    expect(host.querySelector('.prov-row')?.textContent).toContain('Claude');
    expect(loginTerminal.openCliLoginTerminal).not.toHaveBeenCalled();
    expect(window.nexus.providers.installCli).not.toHaveBeenCalled();
    act(() => root.unmount());
  });

  beforeEach(() => {
    useProviderStore.setState({
      providers: [
        provider('claude', 'Claude'),
        provider('codex', 'Codex'),
        provider('kimi', 'Kimi', { installed: false }),
        provider('glm', 'GLM', { kind: 'api-provider' }),
      ],
      hydrate: vi.fn(async () => undefined),
    } as never);
    useAccountStore.setState({
      accounts: [
        {
          id: 'a1',
          adapterId: 'claude',
          label: 'Principal',
          mode: 'subscription',
          upstream: 'anthropic',
          createdAt: 1,
          active: true,
          hasCredential: true,
          onCooldown: false,
          needsRelogin: false,
          email: 'retornoja@gmail.com',
        },
      ],
    });
    Object.defineProperty(window, 'nexus', {
      configurable: true,
      value: {
        providers: {
          authStatus: vi.fn(async () => []),
          installCli: vi.fn(async () => ({ ok: true })),
        },
        adapters: { rescan: vi.fn(async () => []) },
      },
    });
  });

  afterEach(() => {
    Reflect.deleteProperty(window, 'nexus');
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  it('shows a detected count and tile grid of installed CLIs by default', () => {
    const { host, root } = mount();
    expect(host.querySelector('[data-testid="prov-detected-count"]')?.textContent)
      .toMatch(/2 detectados/);
    const tiles = host.querySelectorAll('[data-testid="prov-tile-grid"] .prov-row');
    expect(tiles.length).toBe(2);
    expect(host.textContent).toContain('Claude');
    expect(host.textContent).toContain('Codex');
    expect(host.textContent).not.toContain('Kimi');
    expect(host.textContent).toContain('2/2');
    // Single rescan CTA (no duplicate buttons).
    const refresh = [...host.querySelectorAll('button')].filter((b) =>
      /Reexaminar CLIs|Examinando/.test(b.textContent ?? ''),
    );
    expect(refresh).toHaveLength(1);
    act(() => root.unmount());
  });

  it('uses the observed login state throughout the selected provider, ignoring a stale login hint', async () => {
    useProviderStore.setState({ providers: [provider('claude', 'Claude', {
      authStrategy: 'login-needed', loginCommand: 'claude auth login',
      loginHint: 'A CLI claude não tem sessão.',
    })] });
    vi.mocked(window.nexus.providers.authStatus).mockResolvedValue([
      { adapterId: 'claude', state: 'ok', detail: 'Logged in as dev@example.com' },
    ]);
    const { host, root } = mount();
    await act(async () => { await Promise.resolve(); });

    expect(host.querySelector('.prov-row__status')?.textContent).toBe('conectado');
    expect(host.querySelector('.acct__status')?.textContent).toBe('conectado');
    expect(host.textContent).not.toContain('não tem sessão');
    expect(host.querySelector('[data-testid="prov-login-claude"]')).toBeNull();
    act(() => root.unmount());
  });

  it('shows an unverified state consistently when the auth probe cannot confirm a session', async () => {
    vi.mocked(window.nexus.providers.authStatus).mockResolvedValue([
      { adapterId: 'claude', state: 'unknown', detail: 'Verificação indisponível.' },
    ]);
    const { host, root } = mount();
    await act(async () => { await Promise.resolve(); });

    expect(host.querySelector('.prov-row__status')?.textContent).toBe('não verificado');
    expect(host.querySelector('.acct__status')?.textContent).toBe('não verificado');
    expect(host.querySelector('.acct__implicit')).toBeNull();
    act(() => root.unmount());
  });

  it('reconciles a newer provider snapshot without starting an auth probe loop', async () => {
    vi.mocked(window.nexus.providers.authStatus).mockResolvedValue([
      { adapterId: 'claude', state: 'ok', detail: 'Logged in as dev@example.com' },
    ]);
    const { host, root } = mount();
    await act(async () => { await Promise.resolve(); });
    await act(async () => {
      useProviderStore.setState({ providers: [provider('claude', 'Claude', {
        authState: 'unknown', loginCommand: 'claude auth login',
      })] });
    });

    expect(host.querySelector('.prov-row__status')?.textContent).toBe('não verificado');
    expect(host.querySelector('.acct__status')?.textContent).toBe('não verificado');
    expect(host.textContent).not.toContain('dev@example.com');
    expect(window.nexus.providers.authStatus).toHaveBeenCalledTimes(1);
    act(() => root.unmount());
  });

  it('keeps power controls behind Avançado until expanded', async () => {
    const { host, root } = mount();
    expect(host.textContent).toContain('Contas');
    expect(host.textContent).not.toContain('Binário (vazio');

    const advanced = host.querySelector<HTMLButtonElement>('.prov-advanced__toggle');
    expect(advanced).toBeTruthy();
    await act(async () => advanced!.click());
    expect(host.textContent).toContain('Binário (vazio');
    act(() => root.unmount());
  });

  it('switches to Remotos/API tab for api-provider adapters', async () => {
    const { host, root } = mount();
    const tabs = [...host.querySelectorAll<HTMLButtonElement>('.prov-hub__tab')];
    const remote = tabs.find((t) => t.textContent?.includes('Remotos'));
    expect(remote).toBeTruthy();
    await act(async () => remote!.click());
    expect(host.textContent).toContain('GLM');
    expect(host.querySelectorAll('.prov-row').length).toBe(1);
    act(() => root.unmount());
  });

  it('moves keyboard focus with the selected tab and keeps one stable tabpanel', async () => {
    const { host, root } = mount();
    const tabs = [...host.querySelectorAll<HTMLButtonElement>('.prov-hub__tab')];
    tabs[0]!.focus();

    await act(async () => {
      tabs[0]!.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'ArrowRight',
        bubbles: true,
      }));
    });

    expect(document.activeElement).toBe(tabs[1]);
    expect(tabs[1]!.getAttribute('aria-selected')).toBe('true');
    expect(tabs.every((tab) => tab.getAttribute('aria-controls') === 'prov-tabpanel')).toBe(true);
    expect(host.querySelectorAll('#prov-tabpanel')).toHaveLength(1);
    act(() => root.unmount());
  });

  it('surfaces account chip on the tile and detail accounts block', () => {
    const { host, root } = mount();
    expect(host.textContent).toContain('1 conta');
    expect(host.textContent).toContain('Principal');
    act(() => root.unmount());
  });

  it('keeps the provider list for selection and opens login only from the selected detail', async () => {
    loginTerminal.openCliLoginTerminal.mockClear();
    useProviderStore.setState({
      providers: [
        provider('claude', 'Claude'),
        provider('codex', 'Codex', {
          authStrategy: 'login-needed',
          loginCommand: 'codex login',
        }),
      ],
      hydrate: vi.fn(async () => undefined),
    } as never);
    vi.mocked(window.nexus.providers.authStatus).mockResolvedValue([
      { adapterId: 'claude', state: 'ok', detail: 'Sessão verificada.' },
      { adapterId: 'codex', state: 'missing', detail: 'Precisa login.' },
    ]);
    const { host, root } = mount();
    await act(async () => { await Promise.resolve(); });

    const rows = [...host.querySelectorAll('.prov-row')];
    expect(rows.every((row) => row.querySelectorAll('button').length === 1)).toBe(true);
    const codex = host.querySelector<HTMLButtonElement>('.prov-row__select[data-adapter="codex"]');
    await act(async () => { codex!.click(); });
    const login = host.querySelector<HTMLButtonElement>('.prov-detail [data-testid="acct-login-cta"]');
    expect(login).toBeTruthy();
    await act(async () => { login!.click(); });

    expect(loginTerminal.openCliLoginTerminal).toHaveBeenCalledWith(
      expect.objectContaining({ command: 'codex login', adapterId: 'codex' }),
    );
    expect(
      host.querySelector('.acct__notice')?.textContent,
    ).toContain('Terminal de login aberto');
    act(() => root.unmount());
  });

  it('shows one verification action for the selected unknown provider, not one in every list row', async () => {
    useProviderStore.setState({ providers: ['Cursor Agent', 'Gemini CLI', 'Muse Specialist'].map((label, index) =>
      provider(`custom-${index}`, label, { authState: 'unknown', loginCommand: `custom-${index} login` }),
    ) });
    const { host, root } = mount();
    await act(async () => { await Promise.resolve(); });

    expect(host.querySelectorAll('.prov-row button')).toHaveLength(3);
    expect([...host.querySelectorAll('button')].filter((button) =>
      button.textContent === 'Verificar sessão',
    )).toHaveLength(1);
    expect([...host.querySelectorAll('.prov-row__name')].map((name) => name.textContent)).toEqual([
      'Cursor Agent', 'Gemini CLI', 'Muse Specialist',
    ]);
    act(() => root.unmount());
  });

  it('keeps installation available in the selected detail without adding a list action', async () => {
    useProviderStore.setState({ providers: [provider('kimi', 'Kimi', {
      installed: false, canAutoInstall: true,
    })] });
    const { host, root } = mount();
    const showAbsent = host.querySelector<HTMLInputElement>('.prov-hub__show-absent input');
    await act(async () => { showAbsent!.click(); });
    expect(host.querySelectorAll('.prov-row button')).toHaveLength(1);
    const install = host.querySelector<HTMLButtonElement>('.prov-detail__install');
    expect(install).toBeTruthy();
    await act(async () => { install!.click(); });
    expect(window.nexus.providers.installCli).toHaveBeenCalledWith('kimi');
    act(() => root.unmount());
  });
});
