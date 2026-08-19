/** @vitest-environment jsdom */
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const browserHost = vi.hoisted(() => ({
  reconcileBrowserPanes: vi.fn(),
  setBrowserPaneSuppression: vi.fn(),
}));

const missionInspectorView = vi.hoisted<{
  selectedTab: () => string;
}>(() => ({
  selectedTab: () => 'agent',
}));

const layoutEffects = vi.hoisted(() => ({
  detachWorkspaceLayout: vi.fn(),
  switchWorkspaceLayoutWithFallback: vi.fn(
    () => new Promise<boolean>(() => undefined),
  ),
}));

vi.mock('./state/layout-store', async (importActual) => ({
  ...(await importActual<Record<string, unknown>>()),
  detachWorkspaceLayout: layoutEffects.detachWorkspaceLayout,
  switchWorkspaceLayoutWithFallback:
    layoutEffects.switchWorkspaceLayoutWithFallback,
}));

vi.mock('./state/workspace-store', async (importActual) => ({
  ...(await importActual<Record<string, unknown>>()),
  useWorkspaceController: () => undefined,
}));

vi.mock('./state/settings-store', async (importActual) => ({
  ...(await importActual<Record<string, unknown>>()),
  useSettingsController: () => undefined,
}));

vi.mock('./state/gamification-store', async (importActual) => ({
  ...(await importActual<Record<string, unknown>>()),
  useGamificationSync: () => undefined,
}));


vi.mock('./state/provider-store', () => ({
  useProviderController: () => undefined,
}));
vi.mock('./state/account-store', () => ({
  useAccountController: () => undefined,
}));
vi.mock('./state/cost-store', () => ({
  useCostController: () => undefined,
}));
vi.mock('./state/usage-store', () => ({ useUsageSync: () => undefined }));
vi.mock('./state/quota-store', () => ({ useQuotaSync: () => undefined }));
vi.mock('./orch/failover-controller', () => ({
  useFailoverController: () => undefined,
}));
vi.mock('./orch/account-restart-controller', () => ({
  useAccountRestartController: () => undefined,
}));
vi.mock('./orch/orch-bridge', () => ({ useOrchBridge: () => undefined }));
vi.mock('./voice/voice-controller', () => ({
  useVoiceController: () => undefined,
}));
vi.mock('./state/dev-server-store', () => ({
  initDevServerStore: () => undefined,
}));
vi.mock('./state/design-selection-store', () => ({
  initDesignSelectionStore: () => undefined,
}));
vi.mock('./orch/restore-agents-gate', () => ({
  gateRestoredAgents: vi.fn(async () => undefined),
  resetRestoredAgentsGate: vi.fn(),
}));
vi.mock('./terminal/terminal-host', () => ({ reconcileHosts: vi.fn() }));
vi.mock('./browser/browser-host', () => browserHost);
vi.mock('./terminal/pane-close-guard', () => ({ requestPaneClose: vi.fn() }));
vi.mock('./lib/progressive-launch', () => ({
  applyProgressiveLaunchIfPending: vi.fn(() => false),
}));
vi.mock('./lib/use-product-flags', () => ({ useProductFlags: () => ({}) }));

vi.mock('./components/product/Launcher', () => ({
  Launcher: ({
    onOpenWorkspace,
    onStartMission,
    onOpenTaskBoard,
    onOpenMemory,
  }: {
    onOpenWorkspace: () => void;
    onStartMission: () => void;
    onOpenTaskBoard: () => void;
    onOpenMemory: () => void;
  }) => (
    <section data-product-destination="launcher" aria-label="Launcher">
      <button type="button" onClick={onOpenWorkspace}>Abrir workspace</button>
      <button type="button" onClick={onStartMission}>Missão em equipe</button>
      <button type="button" onClick={onOpenTaskBoard}>Abrir Quadro</button>
      <button type="button" onClick={onOpenMemory}>Abrir Memória</button>
    </section>
  ),
}));

vi.mock('./components/product/WorkspaceRail', () => ({
  WorkspaceRail: ({
    onCreateNew,
    onOpenTaskBoard,
    onOpenMemory,
    onOpenSettings,
  }: {
    onCreateNew: () => void;
    onOpenTaskBoard: () => void;
    onOpenMemory: () => void;
    onOpenSettings: () => void;
  }) => (
    <nav aria-label="Destinos do Nexus">
      <button type="button" onClick={onCreateNew}>Novo</button>
      <button type="button" onClick={onOpenTaskBoard}>Quadro</button>
      <button type="button" onClick={onOpenMemory}>Memória</button>
      <button type="button" onClick={onOpenSettings}>Configurações</button>
    </nav>
  ),
}));

vi.mock('./components/mission/MissionSetup', () => ({
  MissionSetup: () => (
    <section data-product-destination="mission-setup" aria-label="Preparar missão" />
  ),
}));

vi.mock('./components/mission/MissionBoard', () => ({
  MissionBoard: ({
    missionId,
    onOpenTerminals,
  }: {
    missionId: string;
    onOpenTerminals: (missionId: string) => void;
  }) => (
    <section
      data-product-destination={`mission-board:${missionId}`}
      aria-label={`Quadro da missão ${missionId}`}
    >
      <div data-mission-inspector-tab={missionInspectorView.selectedTab()}>
        Inspetor da missão
      </div>
      <button type="button" onClick={() => onOpenTerminals(missionId)}>
        Abrir terminais
      </button>
    </section>
  ),
}));

vi.mock('./components/product/TerminalWorkspace', () => ({
  TerminalWorkspace: ({
    missionId,
    onBackToBoard,
    hidden = false,
  }: {
    missionId?: string;
    onBackToBoard?: () => void;
    hidden?: boolean;
  }) => (
    <section
      data-terminal-workspace-host="true"
      data-product-destination={
        missionId ? `mission-terminals:${missionId}` : 'terminal'
      }
      hidden={hidden}
      aria-hidden={hidden ? true : undefined}
      aria-label={missionId ? 'Terminais da missão' : 'Terminais'}
    >
      <button type="button" data-terminal-focus="true">
        Terminal ativo
      </button>
      {onBackToBoard ? (
        <button type="button" onClick={onBackToBoard}>Voltar ao Quadro</button>
      ) : null}
    </section>
  ),
}));

vi.mock('./components/product/TaskBoardWorkspace', () => ({
  TaskBoardWorkspace: () => (
    <section data-product-destination="task-board" aria-label="Quadro" />
  ),
}));
vi.mock('./components/product/MemoryWorkspace', () => ({
  MemoryWorkspace: () => (
    <section data-product-destination="memory" aria-label="Memória" />
  ),
}));
vi.mock('./components/settings/SettingsWorkspace', () => ({
  SettingsWorkspace: () => (
    <section data-product-destination="settings" aria-label="Configurações" />
  ),
}));


vi.mock('./components/CommandPalette', () => ({
  CommandPalette: () => <div data-preserved-overlay="palette" />,
}));
vi.mock('./components/KeyboardCheatsheet', () => ({
  KeyboardCheatsheet: () => <div data-preserved-overlay="cheatsheet" />,
}));
vi.mock('./components/AttentionInbox', () => ({
  AttentionInbox: () => <div data-preserved-overlay="attention" />,
}));
vi.mock('./components/ConfirmDialog', () => ({
  ConfirmDialog: () => <div data-preserved-overlay="confirmation" />,
}));
vi.mock('./components/VoiceHud', () => ({
  VoiceHud: () => <div data-preserved-overlay="voice-hud" />,
}));
vi.mock('./components/VoiceSettings', () => ({
  VoiceSettings: () => <div data-preserved-overlay="voice-settings" />,
}));
vi.mock('./overlay/overlay-layer', () => ({
  OverlayLayer: ({ children }: { children: ReactNode }) => (
    <div data-overlay-layer="true">{children}</div>
  ),
}));

vi.mock('./components/CloseWorkspaceDialog', async (importActual) => ({
  ...(await importActual<Record<string, unknown>>()),
  CloseWorkspaceDialog: () => <div data-hard-confirmation="close-workspace" />,
}));
vi.mock('./components/OrchestrationModeDialog', () => ({
  OrchestrationModeDialog: () => (
    <div data-obsolete-app-mount="OrchestrationModeDialog" />
  ),
}));
vi.mock('./components/Toasts', () => ({ Toasts: () => null }));
vi.mock('./components/OperatorProfile', () => ({ OperatorProfile: () => null }));
vi.mock('./components/MediaStudioPanel', () => ({ MediaStudioPanel: () => null }));
vi.mock('./components/FanoutComparePanel', () => ({
  FanoutComparePanel: () => <div>Comparação da missão</div>,
}));
vi.mock('./components/product/MissionJournalPanel', () => ({
  MissionJournalPanel: () => <div>Diário da missão</div>,
}));
vi.mock('./components/GitPanelBody', () => ({
  GitPanelBody: () => <div>Alterações Git</div>,
}));
vi.mock('./components/product/ProductPanelBodies', () => ({
  EditorPanelBody: () => <div>Editor contextual</div>,
  MarketplacePanelBody: () => <div>Marketplace contextual</div>,
  MemoryPanelBody: () => <div>Memória contextual</div>,
  SearchPanelBody: () => <div>Busca contextual</div>,
  SkillsPanelBody: () => <div>Skills contextual</div>,
}));
vi.mock('./components/NexusMark', () => ({ NexusMark: () => null }));
vi.mock('./components/PixelIcon', () => ({ PixelIcon: () => null }));

import { App } from './App';
import { useAgentNotificationStore } from './state/agent-notification-store';
import { useCheatsheetStore } from './state/cheatsheet-store';
import { useAttentionInboxStore } from './state/attention-inbox-store';
import { useCommandPaletteStore } from './state/command-palette-store';
import { useConfirmStore } from './state/confirm-store';
import { useGamificationStore } from './state/gamification-store';
import { useContextualPanelNavStore } from './state/contextual-panel-nav-store';
import { useLayoutStore } from './state/layout-store';
import { useMediaStudioStore } from './state/media-studio-store';
import { useMissionSetupStore } from './state/mission-setup-store';
import { useMissionInspectorStore } from './state/mission-inspector-store';
import { useOrchStore } from './state/orch-store';
import { useProductNavigationStore } from './state/product-navigation-store';
import { useToastStore } from './state/toast-store';
import { useVoiceStore } from './voice/voice-store';
import { useWorkspaceStore } from './state/workspace-store';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

const mountedRoots: Root[] = [];
const originalNexusDescriptor = Object.getOwnPropertyDescriptor(window, 'nexus');
let attentionHandler: ((event: Record<string, unknown>) => void) | null = null;

function currentDestination(host: HTMLElement): string | null {
  const destinations = [
    ...host.querySelectorAll<HTMLElement>(
      'main.product-canvas [data-product-destination]',
    ),
  ].filter((destination) => destination.closest('[hidden]') === null);
  expect(destinations).toHaveLength(1);
  return destinations[0]?.dataset.productDestination ?? null;
}

function mountApp(): HTMLElement {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  mountedRoots.push(root);
  act(() => root.render(<App />));
  return host;
}

function openWorkspace(): void {
  useWorkspaceStore.setState({
    current: {
      path: '/tmp/nexus-workspace',
      name: 'Nexus Workspace',
      lastOpenedAt: 1,
    },
    recents: [],
    hydrated: true,
  });
  useLayoutStore.setState({
    hydrated: true,
    viewKind: 'grid',
    focusedPaneId: 'pane-terminal',
    root: {
      kind: 'leaf',
      id: 'leaf-terminal',
      pane: { id: 'pane-terminal', kind: 'shell', title: 'Terminal' },
    },
  } as never);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  missionInspectorView.selectedTab = () =>
    useMissionInspectorStore.getState().tab;
  attentionHandler = null;

  Object.defineProperty(window, 'nexus', {
    configurable: true,
    writable: true,
    value: {
      app: { onDeepOpenPath: vi.fn(() => vi.fn()) },
      pet: {
        onOpenSettings: vi.fn(() => vi.fn()),
        onOpenOps: vi.fn(() => vi.fn()),
        onAttention: vi.fn((handler: (event: Record<string, unknown>) => void) => {
          attentionHandler = handler;
          return vi.fn();
        }),
      },
    },
  });

  useWorkspaceStore.setState({ current: null, recents: [], hydrated: true });
  useLayoutStore.setState({
    hydrated: false,
    viewKind: 'grid',
    focusedPaneId: 'pane-terminal',
    root: {
      kind: 'leaf',
      id: 'leaf-terminal',
      pane: { id: 'pane-terminal', kind: 'shell', title: 'Terminal' },
    },
  } as never);
  useProductNavigationStore.setState({
    destination: { kind: 'launcher' },
    settingsReturnDestination: null,
  });
  useMissionInspectorStore.setState({
    missionId: null,
    tab: 'agent',
    selectedAgentId: null,
  });
  useContextualPanelNavStore.setState({
    requestedTab: null,
    requestId: 0,
  });
  useOrchStore.setState({
    missions: [],
    missionSummaries: [],
    boundWorkspacePath: null,
  } as never);
  useMediaStudioStore.setState({ open: false } as never);
  useGamificationStore.setState({ profileOpen: false } as never);
  useCommandPaletteStore.setState({ open: false });
  useAttentionInboxStore.setState({ open: false });
  useAgentNotificationStore.setState({ items: [], open: false });
  useConfirmStore.setState({ pending: null });
  useCheatsheetStore.setState({ open: false });
  useVoiceStore.setState({ settingsOpen: false } as never);
  useToastStore.setState({ toasts: [] });
});

afterEach(() => {
  act(() => {
    for (const root of mountedRoots.splice(0)) root.unmount();
  });
  document.body.replaceChildren();
  window.sessionStorage.clear();
  window.localStorage.clear();
  vi.clearAllTimers();
  vi.useRealTimers();
  if (originalNexusDescriptor) {
    Object.defineProperty(window, 'nexus', originalNexusDescriptor);
  } else {
    Reflect.deleteProperty(window, 'nexus');
  }
});

describe('App Nexus V2 cutover', () => {
  it('boots without a workspace into one AppShell Launcher', () => {
    const host = mountApp();

    expect(host.querySelectorAll('.nexus-shell')).toHaveLength(1);
    expect(currentDestination(host)).toBe('launcher');
    expect(
      host.querySelectorAll('[data-terminal-workspace-host="true"]'),
    ).toHaveLength(0);
  });

  it('opens an available workspace at the canonical Terminal destination', () => {
    openWorkspace();
    const host = mountApp();

    expect(useProductNavigationStore.getState().destination).toEqual({
      kind: 'terminal',
    });
    expect(currentDestination(host)).toBe('terminal');
  });

  it('keeps the scheduler terminal host mounted but hidden while Mission Board is active', () => {
    openWorkspace();
    useProductNavigationStore.getState().openMission('mission-scheduler');
    const host = mountApp();

    const terminalHost = host.querySelector<HTMLElement>(
      '[data-terminal-workspace-host="true"]',
    );
    expect(terminalHost).not.toBeNull();
    expect(
      host.querySelectorAll('[data-terminal-workspace-host="true"]'),
    ).toHaveLength(1);
    expect(terminalHost?.hidden).toBe(true);
    expect(terminalHost?.getAttribute('aria-hidden')).toBe('true');
    expect(
      terminalHost?.querySelector('[data-terminal-focus="true"]')?.closest(
        '[hidden]',
      ),
    ).toBe(terminalHost);
    expect(currentDestination(host)).toBe(
      'mission-board:mission-scheduler',
    );

    act(() =>
      useProductNavigationStore.getState().showMissionTerminals(),
    );

    const revealedHost = host.querySelector<HTMLElement>(
      '[data-terminal-workspace-host="true"]',
    );
    expect(revealedHost).toBe(terminalHost);
    expect(revealedHost?.hidden).toBe(false);
    expect(revealedHost?.hasAttribute('aria-hidden')).toBe(false);
    expect(currentDestination(host)).toBe(
      'mission-terminals:mission-scheduler',
    );

    act(() => useProductNavigationStore.getState().openTaskBoard());

    expect(
      host.querySelector('[data-terminal-workspace-host="true"]'),
    ).toBe(terminalHost);
    expect(terminalHost?.hidden).toBe(true);
    expect(currentDestination(host)).toBe('task-board');
  });

  it('reparents the contextual panel with a deterministic focus round trip', () => {
    openWorkspace();
    useProductNavigationStore.getState().openTerminal();
    const host = mountApp();
    const trigger = host.querySelector<HTMLButtonElement>(
      '[aria-label="Abrir painel de contexto"]',
    );

    expect(trigger).not.toBeNull();
    expect(host.querySelector('.product-inspector')).toBeNull();

    act(() => {
      trigger?.focus();
      trigger?.click();
    });

    const selectedTab = host.querySelector<HTMLButtonElement>(
      '.product-inspector [role="tab"][aria-selected="true"]',
    );
    const labels = Array.from(
      host.querySelectorAll<HTMLButtonElement>(
        '.product-inspector [role="tab"]',
      ),
      (tab) => tab.textContent,
    );
    expect(selectedTab?.textContent).toBe('Missão');
    expect(document.activeElement).toBe(selectedTab);
    expect(labels).not.toContain('Browser');
    expect(
      host.querySelector('[data-testid="ctx-tab-mission"]')?.textContent,
    ).toContain('Diário da missão');

    for (const [label, expectedBody] of [
      ['Missão', 'Diário da missão'],
      ['Editor', 'Editor contextual'],
      ['Git', 'Alterações Git'],
      ['Busca', 'Busca contextual'],
      ['Skills', 'Skills contextual'],
      ['Marketplace', 'Marketplace contextual'],
      ['Memória', 'Memória contextual'],
    ] as const) {
      const tab = Array.from(
        host.querySelectorAll<HTMLButtonElement>(
          '.product-inspector [role="tab"]',
        ),
      ).find((candidate) => candidate.textContent === label);
      act(() => tab?.click());
      expect(
        host.querySelector('.product-inspector [role="tabpanel"]')
          ?.textContent,
      ).toContain(expectedBody);
    }
    const hide = host.querySelector<HTMLButtonElement>(
      '[aria-label="Ocultar painel"]',
    );
    act(() => {
      hide?.focus();
      hide?.click();
    });

    const restoredTrigger = host.querySelector<HTMLButtonElement>(
      '[aria-label="Abrir painel de contexto"]',
    );
    expect(host.querySelector('.product-inspector')).toBeNull();
    expect(document.activeElement).toBe(restoredTrigger);
  });

  it('preserves terminal focus when Alt+] toggles contextual visibility', () => {
    openWorkspace();
    useProductNavigationStore.getState().openTerminal();
    const host = mountApp();
    const terminalControl = host.querySelector<HTMLButtonElement>(
      '[data-terminal-focus="true"]',
    );
    terminalControl?.focus();
    const event = new KeyboardEvent('keydown', {
      key: ']',
      altKey: true,
      bubbles: true,
      cancelable: true,
    });

    act(() => window.dispatchEvent(event));

    expect(event.defaultPrevented).toBe(true);
    expect(host.querySelector('.product-inspector')).not.toBeNull();
    expect(document.activeElement).toBe(terminalControl);
  });
  it('renders exactly the active canonical destination through one shell', () => {
    openWorkspace();
    useProductNavigationStore.getState().openTerminal();
    const host = mountApp();
    const nav = useProductNavigationStore.getState();

    const cases: Array<{
      open: () => void;
      expected: string;
    }> = [
      { open: nav.openTerminal, expected: 'terminal' },
      { open: nav.openMissionSetup, expected: 'mission-setup' },
      { open: () => nav.openMission('mission-canonical'), expected: 'mission-board:mission-canonical' },
      { open: nav.showMissionTerminals, expected: 'mission-terminals:mission-canonical' },
      { open: nav.openTaskBoard, expected: 'task-board' },
      { open: nav.openMemory, expected: 'memory' },
      { open: () => nav.openSettings('voice'), expected: 'settings' },
    ];

    for (const route of cases) {
      act(() => route.open());
      expect(host.querySelectorAll('.nexus-shell')).toHaveLength(1);
      expect(currentDestination(host)).toBe(route.expected);
      const terminalHosts = host.querySelectorAll<HTMLElement>(
        '[data-terminal-workspace-host="true"]',
      );
      expect(terminalHosts).toHaveLength(1);
      expect(terminalHosts[0]?.hidden).toBe(
        route.expected !== 'terminal' &&
          !route.expected.startsWith('mission-terminals:'),
      );
    }

    for (const overlay of [
      'palette',
      'attention',
      'cheatsheet',
      'confirmation',
      'voice-hud',
      'voice-settings',
    ]) {
      expect(
        host.querySelectorAll(`[data-preserved-overlay="${overlay}"]`),
      ).toHaveLength(1);
    }
    expect(
      host.querySelector(
        '[data-overlay-layer="true"] [data-preserved-overlay="voice-hud"]',
      ),
    ).not.toBeNull();
    expect(
      host.querySelector(
        '[data-overlay-layer="true"] [data-preserved-overlay="voice-settings"]',
      ),
    ).not.toBeNull();
  });

  it('keeps the named mission authoritative across board, terminals and settings deep links', () => {
    openWorkspace();
    useProductNavigationStore.getState().openMission('mission-release');
    const host = mountApp();

    expect(currentDestination(host)).toBe('mission-board:mission-release');
    const openTerminals = Array.from(
      host.querySelectorAll<HTMLButtonElement>('button'),
    ).find((button) => button.textContent?.includes('Abrir terminais'));
    openTerminals?.focus();
    act(() => openTerminals?.click());
    expect(useProductNavigationStore.getState().destination).toEqual({
      kind: 'mission',
      missionId: 'mission-release',
      surface: 'terminals',
    });
    expect(currentDestination(host)).toBe('mission-terminals:mission-release');
    const canvas = host.querySelector<HTMLElement>('main.product-canvas');
    expect(document.activeElement).toBe(canvas);
    expect(canvas?.getAttribute('aria-label')).toBe('Terminais da missão');

    const back = Array.from(host.querySelectorAll<HTMLButtonElement>('button')).find(
      (button) => button.textContent?.includes('Voltar ao Quadro'),
    );
    back?.focus();
    act(() => back?.click());
    expect(useProductNavigationStore.getState().destination).toEqual({
      kind: 'mission',
      missionId: 'mission-release',
      surface: 'board',
    });
    expect(document.activeElement).toBe(canvas);
    expect(canvas?.getAttribute('aria-label')).toBe('Quadro da missão');

    act(() => useProductNavigationStore.getState().openSettings('voice'));
    act(() => useProductNavigationStore.getState().openSettings('providers'));
    expect(useProductNavigationStore.getState()).toMatchObject({
      destination: { kind: 'settings', section: 'providers' },
      settingsReturnDestination: {
        kind: 'mission',
        missionId: 'mission-release',
        surface: 'board',
      },
    });

    act(() => useProductNavigationStore.getState().backFromSettings());
    expect(currentDestination(host)).toBe('mission-board:mission-release');
  });

  it.each([
    ['n', { kind: 'mission-setup' }],
    ['b', { kind: 'task-board' }],
    [',', { kind: 'settings' }],
  ] as const)('routes ⌘%s through product navigation', (key, expected) => {
    openWorkspace();
    useProductNavigationStore.getState().openTerminal();
    mountApp();

    act(() => {
      window.dispatchEvent(
        new KeyboardEvent('keydown', {
          key,
          metaKey: true,
          bubbles: true,
          cancelable: true,
        }),
      );
    });

    expect(useProductNavigationStore.getState().destination).toEqual(expected);
  });

  it.each([
    ['⌘N', 'n', { metaKey: true }, { kind: 'mission-setup' }],
    ['Ctrl+N', 'n', { ctrlKey: true }, { kind: 'mission-setup' }],
    ['⌘B', 'b', { metaKey: true }, { kind: 'task-board' }],
    ['Ctrl+B', 'b', { ctrlKey: true }, { kind: 'task-board' }],
  ] as const)(
    'routes %s from Launcher and prevents host defaults',
    (_label, key, modifier, expected) => {
      mountApp();
      const event = new KeyboardEvent('keydown', {
        key,
        ...modifier,
        bubbles: true,
        cancelable: true,
      });

      act(() => window.dispatchEvent(event));

      expect(event.defaultPrevented).toBe(true);
      expect(useWorkspaceStore.getState().current).toBeNull();
      expect(useProductNavigationStore.getState().destination).toEqual(
        expected,
      );
      if (expected.kind === 'mission-setup') {
        expect(useMissionSetupStore.getState().workspacePath).toBeNull();
      }
    },
  );

  it('abre a lista de atenção com ⌘J quando há workspace', () => {
    openWorkspace();
    useProductNavigationStore.getState().openTerminal();
    mountApp();
    act(() => {
      window.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'j',
          metaKey: true,
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    expect(useAttentionInboxStore.getState().open).toBe(true);
  });

  it('preserves focus on a persistent WorkspaceRail destination control', () => {
    openWorkspace();
    useProductNavigationStore.getState().openTerminal();
    const host = mountApp();
    const board = Array.from(
      host.querySelectorAll<HTMLButtonElement>('aside.workspace-rail button'),
    ).find((button) => button.textContent === 'Quadro');
    board?.focus();

    act(() => board?.click());

    expect(useProductNavigationStore.getState().destination).toEqual({
      kind: 'task-board',
    });
    expect(document.activeElement).toBe(board);
  });

  it('focuses the routed canvas instead of the notification bell', () => {
    openWorkspace();
    useProductNavigationStore.getState().openTerminal();
    const host = mountApp();
    const bell = host.querySelector<HTMLButtonElement>('.agent-notif__bell');

    act(() => bell?.click());
    const close = document.querySelector<HTMLButtonElement>(
      '[aria-label="Fechar notificações"]',
    );
    expect(document.activeElement).toBe(close);

    act(() => useProductNavigationStore.getState().openTaskBoard());

    expect(document.querySelector('.agent-notif__panel')).toBeNull();
    expect(document.activeElement).toBe(
      host.querySelector('main.product-canvas'),
    );
    expect(document.activeElement).not.toBe(bell);
  });

  it('opens technical mission attention on the named board with Activity inspector', () => {
    openWorkspace();
    useProductNavigationStore.getState().openTerminal();
    const host = mountApp();

    expect(attentionHandler).not.toBeNull();
    act(() => {
      attentionHandler?.({
        kind: 'mission-technical-failure',
        title: 'Publicar release',
        at: 1,
        missionId: 'mission-tech',
        cause: {
          code: 'dispatch-failed',
          headline: 'O despacho abortou antes do worker começar.',
          action: 'Retome a missão após corrigir o runtime.',
        },
      });
    });

    const toast = useToastStore.getState().toasts.find(
      (item) => item.action?.label === 'Ver diagnóstico',
    );
    expect(toast?.action).toBeDefined();

    act(() => {
      void toast?.action?.onClick();
    });

    expect(useProductNavigationStore.getState().destination).toEqual({
      kind: 'mission',
      missionId: 'mission-tech',
      surface: 'board',
    });
    expect(useMissionInspectorStore.getState().tab).toBe('activity');
    expect(
      host.querySelector('[data-mission-inspector-tab="activity"]'),
    ).not.toBeNull();
  });

  it('opens human-decision mission attention on the named board with Conversation inspector', () => {
    openWorkspace();
    useProductNavigationStore.getState().openTerminal();
    const host = mountApp();

    expect(attentionHandler).not.toBeNull();
    act(() => {
      attentionHandler?.({
        kind: 'mission-blocked',
        title: 'Publicar release',
        at: 1,
        missionId: 'mission-human',
        cause: {
          code: 'human-decision',
          headline: 'A missão está esperando uma resposta sua.',
          action: 'Abra a missão e responda a pergunta pendente.',
        },
      });
    });

    const toast = useToastStore.getState().toasts.find(
      (item) => item.action?.label === 'Abrir missão',
    );
    expect(toast?.action).toBeDefined();

    act(() => {
      void toast?.action?.onClick();
    });

    expect(useProductNavigationStore.getState().destination).toEqual({
      kind: 'mission',
      missionId: 'mission-human',
      surface: 'board',
    });
    expect(useMissionInspectorStore.getState().tab).toBe('chat');
    expect(
      host.querySelector('[data-mission-inspector-tab="chat"]'),
    ).not.toBeNull();
  });

  it('missão Pronto/done toasta sucesso, nunca a frase de falha', () => {
    openWorkspace();
    useProductNavigationStore.getState().openTerminal();
    mountApp();

    act(() => {
      attentionHandler?.({
        kind: 'mission-done',
        title: 'Fix the API server',
        at: 1,
        missionId: 'mission-f7eb1133',
      });
    });

    const toast = useToastStore.getState().toasts.find(
      (item) => item.title === 'Missão pronta',
    );
    expect(toast?.kind).toBe('success');
    expect(toast?.detail).toBe('Fix the API server — a missão está pronta.');
    expect(toast?.detail).not.toMatch(/Não foi possível concluir esta etapa/);
  });

  it('suppresses browser panes from canonical destination semantics', () => {
    openWorkspace();
    useProductNavigationStore.getState().openTaskBoard();
    mountApp();

    expect(browserHost.setBrowserPaneSuppression.mock.lastCall?.[1]).toBe(true);

    act(() => useProductNavigationStore.getState().openTerminal());

    expect(browserHost.setBrowserPaneSuppression.mock.lastCall?.[1]).toBe(false);
  });
});
