/** @vitest-environment jsdom */
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_AUDIO_SETTINGS,
  DEFAULT_TERMINAL_SETTINGS,
  DEFAULT_UI_SETTINGS,
} from '../../../shared/settings-types';
import { useEphemeralDraftStore } from '../../state/ephemeral-draft-store';
import { useOrchStore } from '../../state/orch-store';
import { useProductNavigationStore } from '../../state/product-navigation-store';
import { useSettingsStore } from '../../state/settings-store';
import type { SettingsSection } from './settings-nav';
import { SettingsWorkspace } from './SettingsWorkspace';

const terminalRuntime = vi.hoisted(() => ({
  applyTerminalSettings: vi.fn(),
  waitForSession: vi.fn(async () => null as string | null),
  writeToPane: vi.fn(),
  terminalRendererPerformanceSnapshot: vi.fn(() => ({
    performanceMode: 'adaptive' as const,
    hosts: 0,
    visibleHosts: 0,
    activeWebglLeases: 0,
    queuedTerminals: 0,
    queuedChars: 0,
    pendingParseChars: 0,
    droppedBacklogs: 0,
  })),
}));

vi.mock('../../terminal/terminal-host', () => terminalRuntime);

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

const mountedRoots: Array<{ host: HTMLDivElement; root: Root }> = [];

function mount(node: ReactNode): HTMLDivElement {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  mountedRoots.push({ host, root });
  act(() => root.render(node));
  return host;
}

async function settleSectionEffects(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    await Promise.resolve();
  });
}

function installNexusBoundary(): void {
  Object.defineProperty(window, 'nexus', {
    configurable: true,
    value: {
      adapters: {
        list: vi.fn(async () => []),
        onChanged: vi.fn(() => vi.fn()),
      },
      billing: {
        get: vi.fn(async () => ({
          plan: 'free',
          email: null,
          status: 'none',
          renewsAt: null,
          verified: false,
        })),
      },
      settings: {
        get: vi.fn(async () => DEFAULT_TERMINAL_SETTINGS),
        set: vi.fn(async (patch: object) => ({
          ...DEFAULT_TERMINAL_SETTINGS,
          ...patch,
        })),
        uiGet: vi.fn(async () => DEFAULT_UI_SETTINGS),
        uiSet: vi.fn(async (patch: object) => ({
          ...DEFAULT_UI_SETTINGS,
          ...patch,
        })),
        audioGet: vi.fn(async () => DEFAULT_AUDIO_SETTINGS),
        audioSet: vi.fn(async (patch: object) => ({
          ...DEFAULT_AUDIO_SETTINGS,
          ...patch,
        })),
        listShells: vi.fn(async () => ['/bin/zsh']),
        onChanged: vi.fn(() => vi.fn()),
        onUiChanged: vi.fn(() => vi.fn()),
        onAudioChanged: vi.fn(() => vi.fn()),
      },
      remote: {
        bridgeStatus: vi.fn(async () => ({
          running: false,
          urls: [],
          tokenCount: 0,
          clientCount: 0,
        })),
      },
    },
  });
}

function setSearchValue(field: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    'value',
  )?.set;
  if (!setter) throw new Error('HTMLInputElement value setter unavailable');

  act(() => {
    setter.call(field, value);
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function findButton(host: HTMLElement, name: RegExp): HTMLButtonElement {
  const match = [...host.querySelectorAll<HTMLButtonElement>('button')].find(
    (button) =>
      name.test(button.getAttribute('aria-label') ?? button.textContent ?? ''),
  );
  if (!match) throw new Error(`No button matched ${String(name)}`);
  return match;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(
    () => null,
  );
  vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1));
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
  installNexusBoundary();
  useEphemeralDraftStore.getState().clearAll();
  useOrchStore.setState({ squads: [], mcpInfo: null });
  useSettingsStore.setState({
    terminal: DEFAULT_TERMINAL_SETTINGS,
    ui: DEFAULT_UI_SETTINGS,
    audio: DEFAULT_AUDIO_SETTINGS,
    drawerOpen: false,
    drawerSection: null,
    hydrated: true,
  });
  useProductNavigationStore.setState({
    destination: { kind: 'terminal' },
    settingsReturnDestination: null,
  });
});

afterEach(() => {
  for (const { root } of mountedRoots.splice(0).reverse()) {
    act(() => root.unmount());
  }
  document.body.replaceChildren();
  Reflect.deleteProperty(window, 'nexus');
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe('SettingsWorkspace contracts', () => {
  it('reacts to store deep-links while account, appearance, terminal, and remote sections remain reachable in one page shell', async () => {
    useProductNavigationStore.getState().openSettings('account');
    const host = mount(<SettingsWorkspace />);
    await settleSectionEffects();
    const rail = host.querySelector('nav[aria-label="Configurações"]');
    expect(rail).not.toBeNull();

    const cases: Array<[SettingsSection, RegExp, string]> = [
      ['account', /minha conta/i, 'Minha conta'],
      ['appearance', /^aparência$/i, 'Aparência'],
      ['terminal', /^terminal$/i, 'Terminal'],
      ['remote', /^remote$/i, 'Remote'],
    ];

    for (const [section, heading, navTitle] of cases) {
      act(() => useProductNavigationStore.getState().openSettings(section));
      await settleSectionEffects();

      expect(
        host.querySelector('.settings-detail__title')?.textContent ?? '',
      ).toMatch(heading);
      expect(
        host.querySelector('.settings-nav__item[aria-current="page"]')
          ?.textContent ?? '',
      ).toContain(navTitle);
      expect(host.querySelector('nav[aria-label="Configurações"]')).toBe(rail);
    }
  });

  it('keeps all 30 canonical nav rows available and filters them through search', async () => {
    useProductNavigationStore.getState().openSettings('account');
    const host = mount(<SettingsWorkspace />);
    await settleSectionEffects();
    const nav = host.querySelector('nav[aria-label="Configurações"]');
    const search = host.querySelector<HTMLInputElement>(
      'input[aria-label="Buscar nas configurações"]',
    );
    expect(nav).not.toBeNull();
    expect(search).not.toBeNull();
    expect(nav?.querySelectorAll('.settings-nav__item')).toHaveLength(30);
    if (!search) throw new Error('Settings search is unavailable');

    setSearchValue(search, 'xterm');
    await settleSectionEffects();

    const filtered = [
      ...(nav?.querySelectorAll<HTMLButtonElement>('.settings-nav__item') ?? []),
    ];
    expect(filtered).toHaveLength(1);
    expect(filtered[0]!.textContent).toMatch(/terminal/i);

    await act(async () => {
      filtered[0]!.click();
      await Promise.resolve();
    });
    expect(useProductNavigationStore.getState().destination).toEqual({
      kind: 'settings',
      section: 'terminal',
    });
    expect(
      host.querySelector('.settings-detail__title')?.textContent ?? '',
    ).toMatch(/^terminal$/i);
  });

  it('returns to the exact previous product destination from the page back action', async () => {
    const previous = {
      kind: 'mission' as const,
      missionId: 'mission-release',
      surface: 'terminals' as const,
    };
    useProductNavigationStore.setState({
      destination: previous,
      settingsReturnDestination: null,
    });
    useProductNavigationStore.getState().openSettings('appearance');
    const host = mount(<SettingsWorkspace />);
    await settleSectionEffects();

    act(() => findButton(host, /voltar/i).click());
    expect(host.querySelector('.settings-workspace')).toBeNull();

    expect(useProductNavigationStore.getState().destination).toEqual(previous);
    expect(
      useProductNavigationStore.getState().settingsReturnDestination,
    ).toBeNull();
  });

  it('has no dialog, scrim, focus-trap, or Escape-close semantics', async () => {
    useProductNavigationStore.getState().openSettings('account');
    const host = mount(<SettingsWorkspace />);
    await settleSectionEffects();

    expect(host.querySelector('.settings-workspace')).not.toBeNull();
    expect(host.querySelector('[role="dialog"]')).toBeNull();
    expect(host.querySelector('[aria-modal="true"]')).toBeNull();
    expect(host.querySelector('.settings__overlay')).toBeNull();
    expect(host.querySelector('[data-settings-scrim]')).toBeNull();

    const tab = new KeyboardEvent('keydown', {
      key: 'Tab',
      bubbles: true,
      cancelable: true,
    });
    const escape = new KeyboardEvent('keydown', {
      key: 'Escape',
      bubbles: true,
      cancelable: true,
    });
    act(() => {
      window.dispatchEvent(tab);
      window.dispatchEvent(escape);
    });

    expect(tab.defaultPrevented).toBe(false);
    expect(escape.defaultPrevented).toBe(false);
    expect(useProductNavigationStore.getState().destination).toEqual({
      kind: 'settings',
      section: 'account',
    });
  });
});
