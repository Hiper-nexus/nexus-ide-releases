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
          email: 'retornoja@gmail.com',
        },
      ],
    });
    Object.defineProperty(window, 'nexus', {
      configurable: true,
      value: {
        providers: { authStatus: vi.fn(async () => []) },
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
    const tiles = host.querySelectorAll('[data-testid="prov-tile-grid"] .prov-tile');
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
    expect(host.querySelectorAll('.prov-tile').length).toBe(1);
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
    expect(host.textContent).toContain('1 ct');
    expect(host.textContent).toContain('Principal');
    act(() => root.unmount());
  });

  it('logs into a CLI from its own tile, running the command the adapter declares', async () => {
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
    const { host, root } = mount();

    // Só a CLI que precisa de login (e sabe como) ganha o atalho no cartão.
    expect(host.querySelector('[data-testid="prov-login-claude"]')).toBeNull();
    const pill = host.querySelector<HTMLButtonElement>(
      '[data-testid="prov-login-codex"]',
    );
    expect(pill).toBeTruthy();

    await act(async () => pill!.click());

    expect(loginTerminal.openCliLoginTerminal).toHaveBeenCalledWith(
      expect.objectContaining({ command: 'codex login' }),
    );
    expect(
      host.querySelector('[data-testid="prov-login-notice"]')?.textContent,
    ).toContain('codex login');
    act(() => root.unmount());
  });
});
