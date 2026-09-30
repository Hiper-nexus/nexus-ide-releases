/** @vitest-environment jsdom */
import { DEFAULT_LICENSE } from '../shared/billing-types';
import { useAccessStore } from './state/access-store';
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./state/access-store', async (importActual) => {
  const actual = await importActual<typeof import('./state/access-store')>();
  return { ...actual, useAccess: () => actual.useAccessStore() };
});

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


vi.mock('./state/provider-store', async (importActual) => ({
  ...(await importActual<Record<string, unknown>>()),
  useProviderController: () => undefined,
}));
vi.mock('./state/account-store', async (importActual) => ({
  ...(await importActual<Record<string, unknown>>()),
  useAccountController: () => undefined,
}));
vi.mock('./state/cost-store', () => ({
  useCostController: () => undefined,
}));
vi.mock('./state/usage-store', () => ({ useUsageSync: () => undefined }));
vi.mock('./state/quota-store', async (importActual) => ({
  ...(await importActual<typeof import('./state/quota-store')>()),
  useQuotaSync: () => undefined,
}));
vi.mock('./orch/failover-controller', () => ({
  useFailoverController: () => undefined,
}));
vi.mock('./orch/account-restart-controller', () => ({
  useAccountRestartController: () => undefined,
}));
vi.mock('./orch/worker-spawn-failed-controller', () => ({
  useWorkerSpawnFailedController: () => undefined,
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

vi.mock('./components/product/WorkspaceRail', () => ({
  WorkspaceRail: ({
    onCreateNew,
    onOpenLauncher,
    onOpenWorkspace,
    onOpenTaskBoard,
    onOpenMemory,
    onOpenSettings,
    onOpenTerminals,
    onRemoveMission,
    onSelectWorkspace,
  }: {
    onCreateNew: () => void;
    onOpenLauncher: () => void;
    onOpenWorkspace: () => void;
    onOpenTaskBoard: () => void;
    onOpenMemory: () => void;
    onOpenSettings: () => void;
    onOpenTerminals: () => void;
    onRemoveMission: (missionId: string, workspaceId: string) => void;
    onSelectWorkspace: (workspaceId: string) => void;
  }) => (
    <nav aria-label="Destinos do Nexus">
      <button type="button" onClick={() => onSelectWorkspace('/tmp/neighbor')}>Projeto vizinho</button>
      <button type="button" onClick={onCreateNew}>Novo</button>
      <button type="button" onClick={onOpenLauncher}>Início</button>
      <button type="button" onClick={onOpenWorkspace}>Abrir projeto</button>
      <button type="button" onClick={onOpenTerminals}>Terminais</button>
      <button type="button" onClick={onOpenTaskBoard}>Quadro</button>
      <button type="button" onClick={onOpenMemory}>Memória</button>
      <button type="button" onClick={onOpenSettings}>Configurações</button>
      <button type="button" onClick={() => onRemoveMission('neighbor-mission', '/tmp/neighbor')}>Remover missão vizinha</button>
    </nav>
  ),
}));

vi.mock('./components/mission/MissionSetup', () => ({
  MissionSetup: ({ home }: { home?: boolean }) => (
    <section
      data-product-destination={home ? 'launcher' : 'mission-setup'}
      data-creation-form={home ? 'home' : 'advanced'}
      aria-label="Preparar missão"
    >
      <button type="button" onClick={() => void useWorkspaceStore.getState().pick()}>Escolher pasta da criação</button>
      <button type="button" onClick={() => useProductNavigationStore.getState().openSettings('providers')}>Conectar uma IA</button>
    </section>
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
  TerminalWorkspaceEmpty: ({
    onOpenWorkspace,
  }: {
    onOpenWorkspace: () => void;
  }) => (
    <section
      data-terminal-workspace-empty="true"
      data-product-destination="terminal"
      aria-label="Terminais"
    >
      <p>Escolha uma pasta para abrir os terminais</p>
      <button type="button" onClick={onOpenWorkspace}>Escolher pasta</button>
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
import { gateRestoredAgents } from './orch/restore-agents-gate';
import { useTerminalGridDialogStore } from './state/terminal-grid-dialog-store';
import { useMediaStudioStore } from './state/media-studio-store';
import { useMissionSetupStore } from './state/mission-setup-store';
import { useMissionInspectorStore } from './state/mission-inspector-store';
import { useOrchStore } from './state/orch-store';
import { useProductNavigationStore } from './state/product-navigation-store';
import { useToastStore } from './state/toast-store';
import { useVoiceStore } from './voice/voice-store';
import { useWorkspaceStore } from './state/workspace-store';
import { setActiveWorkspacePath } from './state/active-workspace';

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
  setActiveWorkspacePath('/tmp/nexus-workspace');
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
    focusedPaneId: 'pane-terminal',
    root: {
      kind: 'leaf',
      id: 'leaf-terminal',
      pane: { id: 'pane-terminal', kind: 'shell', title: 'Terminal' },
    },
  } as never);
}

beforeEach(() => {
  useAccessStore.setState({ canUseApp: true, maxAgents: null });
  vi.useFakeTimers();
  vi.clearAllMocks();
  setActiveWorkspacePath(null);
  useMissionSetupStore.setState({ workspacePath: null });
  vi.spyOn(useOrchStore.getState(), 'hydrateCrossWorkspace').mockResolvedValue();
  missionInspectorView.selectedTab = () =>
    useMissionInspectorStore.getState().tab;
  attentionHandler = null;

  Object.defineProperty(window, 'nexus', {
    configurable: true,
    writable: true,
    value: {
      billing: { onChanged: () => () => {}, get: async () => ({ ...DEFAULT_LICENSE, canUseApp: true, blockedReason: null, limits: { maxAgents: null, cloudSync: true } }) },
      app: { onDeepOpenPath: vi.fn(() => vi.fn()), onDeepOpenQuota: vi.fn(() => vi.fn()), onShotFilesReceived: vi.fn(() => vi.fn()) },
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
  useTerminalGridDialogStore.getState().close();
  useLayoutStore.setState({
    hydrated: false,
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
    missionSummariesHydrated: false,
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
  vi.restoreAllMocks();
  if (originalNexusDescriptor) {
    Object.defineProperty(window, 'nexus', originalNexusDescriptor);
  } else {
    Reflect.deleteProperty(window, 'nexus');
  }
});

describe('App Nexus V2 cutover', () => {
  it.each(['board', 'terminals'] as const)('returns to Início when the selected mission disappears from the %s snapshot', (surface) => {
    openWorkspace();
    useOrchStore.setState({
      boundWorkspacePath: '/tmp/nexus-workspace',
      missionSummariesHydrated: true,
      missionSummaries: [{ id: 'mission-removed', title: 'Missão removida', state: 'running' }],
    } as never);
    useProductNavigationStore.setState({ destination: { kind: 'mission', missionId: 'mission-removed', surface } });
    const host = mountApp();
    act(() => useOrchStore.getState().setMissionSummaries([]));
    expect(currentDestination(host)).toBe('launcher');
  });

  it('preserves another selected mission and other workspace summaries on removal', () => {
    openWorkspace();
    const kept = { id: 'mission-kept', title: 'Resultado válido', state: 'completed' };
    const neighbor = [{ id: 'mission-neighbor', title: 'Vizinha', state: 'running' }];
    useOrchStore.setState({
      boundWorkspacePath: '/tmp/nexus-workspace', missionSummariesHydrated: true,
      missionSummaries: [kept, { id: 'mission-removed', title: 'Removida', state: 'running' }],
      crossWorkspaceSummaries: { '/tmp/neighbor': neighbor },
    } as never);
    useProductNavigationStore.getState().openMission('mission-kept');
    const host = mountApp();
    act(() => useOrchStore.getState().setMissionSummaries([kept] as never));
    expect(currentDestination(host)).toBe('mission-board:mission-kept');
    expect(useOrchStore.getState().crossWorkspaceSummaries['/tmp/neighbor']).toEqual(neighbor);
  });

  it('discards an attention callback captured before its mission was removed', () => {
    openWorkspace();
    useOrchStore.setState({
      boundWorkspacePath: '/tmp/nexus-workspace', missionSummariesHydrated: true,
      missionSummaries: [{ id: 'mission-stale', title: 'Removida', state: 'blocked_user' }],
    } as never);
    useProductNavigationStore.getState().openMemory();
    mountApp();
    act(() => attentionHandler?.({ kind: 'mission-blocked', title: 'Removida', at: 1, missionId: 'mission-stale' }));
    const action = useToastStore.getState().toasts.find(toast => toast.action?.label === 'Abrir missão')?.action;
    expect(action).toBeDefined();
    act(() => useOrchStore.getState().setMissionSummaries([]));
    act(() => { void action?.onClick(); });
    expect(useProductNavigationStore.getState().destination).toEqual({ kind: 'memory' });
  });

  it('keeps mission navigation while its workspace summaries are still hydrating', () => {
    openWorkspace();
    useOrchStore.setState({ boundWorkspacePath: '/tmp/nexus-workspace', missionSummariesHydrated: false } as never);
    useProductNavigationStore.getState().openMission('mission-loading');
    const host = mountApp();
    expect(currentDestination(host)).toBe('mission-board:mission-loading');
    act(() => useOrchStore.getState().setMissionSummaries([]));
    expect(currentDestination(host)).toBe('launcher');
  });

  it('does not use the previous workspace snapshot to reject a mission being opened in another workspace', () => {
    openWorkspace();
    useOrchStore.setState({ boundWorkspacePath: '/tmp/previous-workspace', missionSummariesHydrated: true } as never);
    useProductNavigationStore.getState().openMission('mission-next');
    const host = mountApp();
    expect(currentDestination(host)).toBe('mission-board:mission-next');
    act(() => {
      useOrchStore.getState().resetProjectState();
      useOrchStore.setState({ boundWorkspacePath: '/tmp/nexus-workspace' });
    });
    expect(currentDestination(host)).toBe('mission-board:mission-next');
    act(() => useOrchStore.getState().setMissionSummaries([
      { id: 'mission-next', title: 'Vizinha', state: 'completed' },
    ] as never));
    expect(currentDestination(host)).toBe('mission-board:mission-next');
  });

  it('clears a removed mission from the settings return destination without closing settings', () => {
    openWorkspace();
    useOrchStore.setState({ boundWorkspacePath: '/tmp/nexus-workspace', missionSummariesHydrated: true } as never);
    useProductNavigationStore.getState().openMission('mission-removed');
    useProductNavigationStore.getState().openSettings('providers');
    mountApp();
    expect(useProductNavigationStore.getState().destination).toEqual({ kind: 'settings', section: 'providers' });
    act(() => useProductNavigationStore.getState().backFromSettings());
    expect(useProductNavigationStore.getState().destination).toEqual({ kind: 'launcher' });
  });

  it('allows a newly created mission to open before its first canonical broadcast', () => {
    openWorkspace();
    useOrchStore.setState({ boundWorkspacePath: '/tmp/nexus-workspace', missionSummariesHydrated: true } as never);
    const host = mountApp();
    act(() => useProductNavigationStore.getState().openMission('mission-created'));
    expect(currentDestination(host)).toBe('mission-board:mission-created');
    act(() => useOrchStore.getState().setMissionSummaries([
      { id: 'mission-created', title: 'Nova missão', state: 'running' },
    ] as never));
    expect(currentDestination(host)).toBe('mission-board:mission-created');
  });

  it('navegar para outro projeto pelo rail cai nos terminais, não no destino anterior', async () => {
    // Trocar de projeto com o wizard aberto deixava o destino `mission-setup`
    // colado: o operador clicava no workspace e caía em "O que você quer
    // criar?" em vez de ver os terminais dele. O caminho do Finder
    // (onDeepOpenPath) já abre nos terminais; o rail passa a fazer o mesmo.
    openWorkspace();
    useProductNavigationStore.getState().openMissionSetup();
    vi.spyOn(useWorkspaceStore.getState(), 'open').mockImplementation(async (path) => {
      useWorkspaceStore.setState({ current: { path, name: 'Neighbor', lastOpenedAt: 1 } });
    });
    const host = mountApp();
    const neighbor = [...host.querySelectorAll('button')].find(
      (button) => button.textContent === 'Projeto vizinho',
    );
    expect(neighbor).toBeDefined();

    await act(async () => {
      neighbor!.click();
      await vi.dynamicImportSettled();
    });

    expect(useWorkspaceStore.getState().current?.path).toBe('/tmp/neighbor');
    expect(useProductNavigationStore.getState().destination).toEqual({ kind: 'terminal' });
  });

  it('remove missão de outro projeto só depois de confirmar e ativar o projeto correto', async () => {
    openWorkspace();
    const workspaceOpen = vi.spyOn(useWorkspaceStore.getState(), 'open').mockImplementation(async (path) => {
      useWorkspaceStore.setState({ current: { path, name: 'Neighbor', lastOpenedAt: 1 } });
    });
    const removeMission = vi.fn().mockResolvedValue({ removed: true });
    Object.assign(window.nexus, { orch: { removeMission } });
    const host = mountApp();
    const remove = [...host.querySelectorAll('button')].find(button => button.textContent === 'Remover missão vizinha');
    await act(async () => {
      remove!.click();
      remove!.click();
      await vi.dynamicImportSettled();
    });
    expect(useConfirmStore.getState().pending?.body).toContain('sessões do projeto atual serão encerradas');
    expect(useConfirmStore.getState().queue).toHaveLength(0);
    expect(workspaceOpen).not.toHaveBeenCalled();
    expect(removeMission).not.toHaveBeenCalled();
    await act(async () => useConfirmStore.getState().decide(true));
    expect(workspaceOpen).toHaveBeenCalledWith('/tmp/neighbor');
    expect(removeMission).toHaveBeenCalledWith('neighbor-mission');
    expect(workspaceOpen.mock.invocationCallOrder[0]).toBeLessThan(removeMission.mock.invocationCallOrder[0]);
    expect(useProductNavigationStore.getState().destination.kind).not.toBe('mission');
    workspaceOpen.mockRestore();
  });

  it('não entrega agentes recém-criados ao fluxo de restaurar sessões antigas', async () => {
    let finishRestore!: (value: boolean) => void;
    layoutEffects.switchWorkspaceLayoutWithFallback.mockImplementationOnce(
      () => new Promise<boolean>(resolve => { finishRestore = resolve; }),
    );
    openWorkspace();
    mountApp();
    act(() => {
      useLayoutStore.getState().setPanes([{ id: 'fresh-agent', kind: 'cli-agent', title: 'Codex', adapterId: 'codex' }]);
    });
    await act(async () => finishRestore(true));
    expect(gateRestoredAgents).not.toHaveBeenCalled();
  });

  it('abre a configuração de IA pelo atalho de onboarding', () => {
    const host = mountApp();
    const action = [...host.querySelectorAll('button')].find(button => button.textContent === 'Conectar uma IA');
    act(() => action!.click());
    expect(useProductNavigationStore.getState().destination).toEqual({ kind: 'settings', section: 'providers' });
  });

  it('boots without a workspace directly into the creation form', () => {
    const host = mountApp();

    expect(host.querySelectorAll('.nexus-shell')).toHaveLength(1);
    expect(currentDestination(host)).toBe('launcher');
    expect(host.querySelector('[data-creation-form="home"]')).not.toBeNull();
    expect(host.querySelector('[aria-label="Launcher"]')).toBeNull();
    expect(host.querySelector('.product-header__name')?.textContent).toBe('Seu espaço');
    expect(host.querySelector('.product-header__destination')?.textContent).toBe('Criar com IA');
    expect(
      host.querySelectorAll('[data-terminal-workspace-host="true"]'),
    ).toHaveLength(0);
  });

  it('mostra uma ação em vez de tela preta ao abrir Terminais sem workspace', async () => {
    const pick = vi.spyOn(useWorkspaceStore.getState(), 'pick').mockImplementation(async () => {
      openWorkspace();
    });
    const host = mountApp();
    act(() => useProductNavigationStore.getState().openTerminal());

    expect(host.querySelector('[data-terminal-workspace-empty="true"]')).not.toBeNull();
    const choose = [...host.querySelectorAll('button')].find(
      (button) => button.textContent === 'Escolher pasta',
    );
    expect(choose).toBeDefined();
    await act(async () => choose!.click());
    expect(pick).toHaveBeenCalledOnce();
    expect(useWorkspaceStore.getState().current?.path).toBe('/tmp/nexus-workspace');
    pick.mockRestore();
  });

  it.each(['launcher', 'mission-setup'] as const)('keeps %s open when its folder picker activates the workspace', async (route) => {
    vi.spyOn(useWorkspaceStore.getState(), 'pick').mockImplementation(async () => {
      openWorkspace();
    });
    const host = mountApp();
    if (route === 'mission-setup') {
      act(() => useProductNavigationStore.getState().openMissionSetup());
    }
    const picker = [...host.querySelectorAll('button')].find(
      (button) => button.textContent === 'Escolher pasta da criação',
    );
    expect(picker).toBeDefined();

    await act(async () => picker!.click());

    expect(useWorkspaceStore.getState().current?.path).toBe('/tmp/nexus-workspace');
    expect(useProductNavigationStore.getState().destination).toEqual({ kind: route });
    expect(host.querySelector('[data-creation-form]')).not.toBeNull();
    expect(host.querySelector<HTMLElement>('[data-terminal-workspace-host="true"]')?.hidden).toBe(true);
  });

  it('keeps the creation destination after cancelling a picker and opening a project later', async () => {
    vi.spyOn(useWorkspaceStore.getState(), 'pick').mockResolvedValue();
    const host = mountApp();
    const picker = [...host.querySelectorAll('button')].find(
      (button) => button.textContent === 'Escolher pasta da criação',
    );
    expect(picker).toBeDefined();
    await act(async () => picker!.click());

    act(() => openWorkspace());

    expect(currentDestination(host)).toBe('launcher');
  });

  it('returns from provider settings to the same creation destination', () => {
    const host = mountApp();
    act(() => useProductNavigationStore.getState().openSettings('providers'));
    act(() => useProductNavigationStore.getState().backFromSettings());

    expect(currentDestination(host)).toBe('launcher');
    expect(host.querySelector('[data-creation-form="home"]')).not.toBeNull();
  });

  it('boots with an available workspace directly into creation instead of Terminal', () => {
    openWorkspace();
    const host = mountApp();

    expect(useProductNavigationStore.getState().destination).toEqual({
      kind: 'launcher',
    });
    expect(currentDestination(host)).toBe('launcher');
    expect(host.querySelector('[data-creation-form="home"]')).not.toBeNull();
  });

  it('leaves a previous project mission for creation when the workspace changes', () => {
    openWorkspace();
    useProductNavigationStore.getState().openMission('old-project-mission');
    const host = mountApp();

    act(() => useWorkspaceStore.setState({
      current: { path: '/tmp/new-project', name: 'Novo projeto', lastOpenedAt: 2 },
    }));

    expect(useProductNavigationStore.getState().destination).toEqual({ kind: 'launcher' });
    expect(currentDestination(host)).toBe('launcher');
  });

  it('keeps an explicitly selected Terminal destination when the workspace changes', () => {
    openWorkspace();
    useProductNavigationStore.getState().openTerminal();
    const host = mountApp();

    act(() => useWorkspaceStore.setState({
      current: { path: '/tmp/new-project', name: 'Novo projeto', lastOpenedAt: 2 },
    }));

    expect(currentDestination(host)).toBe('terminal');
  });

  it('returns from Settings to creation after leaving the previous mission project', () => {
    openWorkspace();
    useProductNavigationStore.getState().openMission('old-project-mission');
    useProductNavigationStore.getState().openSettings('providers');
    const host = mountApp();

    act(() => useWorkspaceStore.setState({
      current: { path: '/tmp/new-project', name: 'Novo projeto', lastOpenedAt: 2 },
    }));

    expect(currentDestination(host)).toBe('settings');
    act(() => useProductNavigationStore.getState().backFromSettings());
    expect(currentDestination(host)).toBe('launcher');
  });

  it('keeps project identity beside the active destination in the header', () => {
    openWorkspace();
    const host = mountApp();
    act(() => useProductNavigationStore.getState().openMissionSetup());

    expect(host.querySelector('.product-header__name')?.textContent).toBe('Nexus Workspace');
    expect(host.querySelector('.product-header__destination')?.textContent).toBe('Criar com IA');
    expect(host.querySelectorAll('.product-header__tools')).toHaveLength(1);
  });

  it('shows the mic level bars in the header while capturing, independent of the HUD', () => {
    openWorkspace();
    const host = mountApp();
    const header = host.querySelector('.product-header__tools');
    const bars = () =>
      header?.querySelector('[data-testid="voice-level-bars"]') ?? null;

    // Fora da captura não há barra: sinal de "estou ouvindo" não pode ser decorativo.
    expect(bars()).toBeNull();

    act(() => useVoiceStore.getState().setStatus('listening'));
    expect(bars()).not.toBeNull();

    act(() => useVoiceStore.getState().setStatus('idle'));
    expect(bars()).toBeNull();
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

  it('rail Terminais abre o grid da missão, sem clique no workspace (F-005)', () => {
    openWorkspace();
    useProductNavigationStore.getState().openMission('mission-release');
    const host = mountApp();
    const railTerminals = Array.from(
      host.querySelectorAll<HTMLButtonElement>('aside.workspace-rail button'),
    ).find((button) => button.textContent === 'Terminais');
    expect(railTerminals).toBeTruthy();
    act(() => railTerminals?.click());
    expect(useProductNavigationStore.getState().destination).toEqual({
      kind: 'mission',
      missionId: 'mission-release',
      surface: 'terminals',
    });
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

  it('keeps a pane with a transient mission binding in that mission via ⌘1', () => {
    openWorkspace();
    useLayoutStore.setState({
      root: {
        kind: 'leaf',
        id: 'leaf-transient-mission-pane',
        pane: {
          id: 'pane-transient-mission',
          kind: 'cli-agent',
          title: 'Agente da missão',
          adapterId: 'codex',
        },
      },
      focusedPaneId: null,
    } as never);
    useOrchStore.setState({
      paneMissions: { 'pane-transient-mission': 'mission-release' },
    } as never);
    mountApp();

    act(() => {
      window.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: '1',
          metaKey: true,
          bubbles: true,
          cancelable: true,
        }),
      );
    });

    expect(useProductNavigationStore.getState().destination).toEqual({
      kind: 'mission',
      missionId: 'mission-release',
      surface: 'terminals',
    });
    expect(useLayoutStore.getState().focusedPaneId).toBe(
      'pane-transient-mission',
    );
  });

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
        title: 'SaaS lista de espera com EXATAMENTE',
        at: 1,
        missionId: 'mission-f7eb1133',
      });
    });

    const toast = useToastStore.getState().toasts.find(
      (item) => item.title === 'Missão pronta',
    );
    expect(toast?.kind).toBe('success');
    expect(toast?.detail).toBe(
      'SaaS lista de espera com EXATAMENTE — o resultado final está pronto.',
    );
    expect(toast?.action?.label).toBe('Ver resultado');
    expect(toast?.detail).not.toMatch(/Não foi possível concluir esta etapa/);
  });

  it('monta pelo BootScreen e hidrata depois sem quebrar a ordem dos hooks', () => {
    // Regressão: um hook declarado ABAIXO dos early returns de BootScreen
    // muda a contagem de hooks entre renders assim que `hydrated` vira true —
    // "Rendered more hooks than during the previous render", tela branca no
    // primeiro boot real. Os demais testes montam já hidratados e não veem.
    useWorkspaceStore.setState({ current: null, recents: [], hydrated: false });

    const host = mountApp();
    expect(host.textContent).toContain('Ligando instrumentos');

    act(() => {
      useWorkspaceStore.setState({
        current: null,
        recents: [],
        hydrated: true,
      });
    });

    // Se a ordem dos hooks quebrasse, este segundo render lançaria e o host
    // ficaria vazio. Ele renderiza o shell — o rail está na tela.
    expect(host.textContent).not.toContain('Ligando instrumentos');
    expect(host.textContent).toContain('Novo');
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

it('blocks pane shortcuts and preserves the workspace tree across access revocation', () => {
  openWorkspace();
  useProductNavigationStore.getState().openTerminal();
  const host = mountApp();
  const tree = useLayoutStore.getState().root;
  act(() => useAccessStore.setState({ canUseApp: false, loading: false, blockedReason: 'trial-ended' }));
  expect(host.querySelector('.access-workspace')?.hasAttribute('inert')).toBe(true);
  act(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'd', ctrlKey: true, bubbles: true })));
  expect(useLayoutStore.getState().root).toBe(tree);
  expect(host.querySelector('[data-preserved-overlay="confirmation"]')).not.toBeNull();
  act(() => useAccessStore.setState({ canUseApp: true }));
  expect(host.querySelector('.access-workspace')?.hasAttribute('inert')).toBe(false);
  expect(useLayoutStore.getState().root).toBe(tree);
});
