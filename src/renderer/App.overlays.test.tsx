/** @vitest-environment jsdom */
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const browserHost = vi.hoisted(() => ({
  reconcileBrowserPanes: vi.fn(),
  setBrowserPaneSuppression: vi.fn(),
}));

const layoutEffects = vi.hoisted(() => ({
  detachWorkspaceLayout: vi.fn(),
  switchWorkspaceLayoutWithFallback: vi.fn(
    () => Promise.withResolvers<boolean>().promise,
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
vi.mock('./state/cost-store', () => ({ useCostController: () => undefined }));
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

vi.mock('./components/product/AppShell', () => ({
  AppShell: ({
    rail,
    header,
    content,
    inspector,
    overlays,
  }: {
    rail: ReactNode;
    header?: ReactNode;
    content: ReactNode;
    inspector?: ReactNode;
    overlays?: ReactNode;
  }) => (
    <div data-testid="app-shell">
      {rail}
      {header}
      <main>{content}</main>
      {inspector}
      <div data-testid="root-overlays">{overlays}</div>
    </div>
  ),
}));
vi.mock('./components/product/WorkspaceRail', () => ({
  WorkspaceRail: () => <nav aria-label="Destinos do Nexus" />,
}));
vi.mock('./components/mission/MissionSetup', () => ({
  MissionSetup: () => <section aria-label="Preparar missão" />,
}));
vi.mock('./components/mission/MissionBoard', () => ({
  MissionBoard: () => <section aria-label="Quadro da missão" />,
}));
vi.mock('./components/product/TerminalWorkspace', () => ({
  TerminalWorkspace: () => <section aria-label="Terminais" />,
}));
vi.mock('./components/product/TaskBoardWorkspace', () => ({
  TaskBoardWorkspace: () => <section aria-label="Quadro" />,
}));
vi.mock('./components/product/MemoryWorkspace', () => ({
  MemoryWorkspace: () => <section aria-label="Memória" />,
}));
vi.mock('./components/settings/SettingsWorkspace', () => ({
  SettingsWorkspace: () => <section aria-label="Configurações" />,
}));
vi.mock('./components/ContextualPanel', () => ({
  ContextualPanel: () => null,
}));
vi.mock('./components/product/ProductPanelBodies', () => ({
  EditorPanelBody: () => null,
  MarketplacePanelBody: () => null,
  MemoryPanelBody: () => null,
  SearchPanelBody: () => null,
  SkillsPanelBody: () => null,
}));
vi.mock('./components/product/MissionJournalPanel', () => ({
  MissionJournalPanel: () => null,
}));
vi.mock('./components/FanoutComparePanel', () => ({
  FanoutComparePanel: () => null,
}));
vi.mock('./components/GitPanelBody', () => ({ GitPanelBody: () => null }));
vi.mock('./components/AgentNotifications', () => ({
  AgentNotifications: () => null,
}));
vi.mock('./components/VoiceHud', () => ({ VoiceHud: () => null }));
vi.mock('./components/VoiceSettings', () => ({ VoiceSettings: () => null }));
vi.mock('./components/CommandPalette', () => ({ CommandPalette: () => null }));
vi.mock('./components/KeyboardCheatsheet', () => ({
  KeyboardCheatsheet: () => null,
}));
vi.mock('./components/AttentionInbox', () => ({ AttentionInbox: () => null }));
vi.mock('./components/ConfirmDialog', () => ({ ConfirmDialog: () => null }));
vi.mock('./components/CloseWorkspaceDialog', async (importActual) => ({
  ...(await importActual<Record<string, unknown>>()),
  CloseWorkspaceDialog: () => null,
}));
vi.mock('./components/Toasts', () => ({ Toasts: () => null }));
vi.mock('./components/NexusMark', () => ({ NexusMark: () => null }));
vi.mock('./components/PixelIcon', () => ({ PixelIcon: () => null }));
vi.mock('./components/ChosenPetPortrait', () => ({
  ChosenPetPortrait: () => null,
}));
vi.mock('./overlay/overlay-layer', () => ({
  OverlayLayer: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

import { App } from './App';
import { useCloseWorkspaceStore } from './components/CloseWorkspaceDialog';
import { EMPTY_GAMIFICATION_SNAPSHOT, useGamificationStore } from './state/gamification-store';
import { useLayoutStore } from './state/layout-store';
import { useMediaStudioStore } from './state/media-studio-store';
import { useOrchStore } from './state/orch-store';
import { useOrchestrationModeStore } from './state/orchestration-mode-store';
import { useProductNavigationStore } from './state/product-navigation-store';
import { useWorkspaceStore } from './state/workspace-store';
import { useCommandPaletteStore } from './state/command-palette-store';
import { useConfirmStore } from './state/confirm-store';
import { useCheatsheetStore } from './state/cheatsheet-store';
import { useVoiceStore } from './voice/voice-store';
import {
  assessTerminalVisibility,
  listBlockingOverlayLabels,
  readUiVisibilityState,
} from './voice/terminal-visibility';
import { currentScreenSnapshot } from './voice/jarvis-screen-context';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

const roots: Root[] = [];
const originalNexusDescriptor = Object.getOwnPropertyDescriptor(window, 'nexus');
const MODE_REPORT = /modo(?: de)? orquestra|orchestration mode/iu;
const MEDIA_REPORT = /estúdio de mídia|media studio/iu;
const PROFILE_REPORT = /perfil(?: de)? operador|operator profile/iu;

function mountApp(): void {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  roots.push(root);
  act(() => root.render(<App />));
}

function dialogContaining(text: string): HTMLElement | null {
  return (
    Array.from(
      document.querySelectorAll<HTMLElement>('[role="dialog"][aria-modal="true"]'),
    ).find(
      (dialog) =>
        dialog.textContent?.includes(text) ||
        dialog.getAttribute('aria-label')?.includes(text),
    ) ?? null
  );
}

function lastBrowserSuppression(): boolean | undefined {
  return browserHost.setBrowserPaneSuppression.mock.calls.at(-1)?.[1];
}

function blockingLabels(): string {
  return listBlockingOverlayLabels(readUiVisibilityState().overlays).join(' ');
}

function terminalVisibility() {
  return assessTerminalVisibility(
    'pane-shell',
    readUiVisibilityState(),
    true,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  Object.defineProperty(window, 'nexus', {
    configurable: true,
    writable: true,
    value: {
      app: { onDeepOpenPath: vi.fn(() => vi.fn()) },
      pet: {
        onOpenSettings: vi.fn(() => vi.fn()),
        onOpenOps: vi.fn(() => vi.fn()),
        onAttention: vi.fn(() => vi.fn()),
      },
      media: {
        listProviders: vi.fn(() => Promise.withResolvers().promise),
        listArtifacts: vi.fn(() => Promise.withResolvers().promise),
        readArtifactDataUrl: vi.fn(async () => ({ ok: false })),
        generate: vi.fn(),
        cancelGenerate: vi.fn(),
        revealArtifact: vi.fn(),
      },
    },
  });

  useWorkspaceStore.setState({
    current: {
      path: '/tmp/nexus-overlays',
      name: 'Nexus Overlays',
      lastOpenedAt: 1,
    },
    recents: [],
    hydrated: true,
  });
  useLayoutStore.setState({
    hydrated: true,
    viewKind: 'grid',
    focusedPaneId: 'pane-shell',
    root: {
      kind: 'split',
      id: 'split-live',
      direction: 'row',
      children: [
        {
          kind: 'leaf',
          id: 'leaf-shell',
          pane: { id: 'pane-shell', kind: 'shell', title: 'Terminal' },
        },
        {
          kind: 'leaf',
          id: 'leaf-browser',
          pane: {
            id: 'pane-browser',
            kind: 'browser',
            title: 'Preview',
            browserUrl: 'https://example.test',
          },
        },
      ],
    },
  } as never);
  useProductNavigationStore.setState({
    destination: { kind: 'terminal' },
    settingsReturnDestination: null,
  });
  useOrchStore.setState({
    missions: [],
    missionSummaries: [],
    squads: [],
    boundWorkspacePath: null,
  } as never);
  useOrchestrationModeStore.setState({ pending: null, queue: [] });
  useMediaStudioStore.setState({ open: false });
  useGamificationStore.setState({
    snapshot: EMPTY_GAMIFICATION_SNAPSHOT,
    sober: false,
    profileOpen: false,
  });
  useCloseWorkspaceStore.setState({ open: false } as never);
  useCommandPaletteStore.setState({ open: false });
  useConfirmStore.setState({ pending: null });
  useCheatsheetStore.setState({ open: false });
  useVoiceStore.setState({ settingsOpen: false } as never);
});

afterEach(() => {
  act(() => {
    const mode = useOrchestrationModeStore.getState();
    if (mode.pending) mode.decide(null);
    for (const root of roots.splice(0)) root.unmount();
  });
  document.body.replaceChildren();
  if (originalNexusDescriptor) {
    Object.defineProperty(window, 'nexus', originalNexusDescriptor);
  } else {
    Reflect.deleteProperty(window, 'nexus');
  }
});

describe('App root blocking overlays', () => {
  it('mounts pending Mode as the reported blocking surface, suppresses the live browser pane, and restores both on resolve', async () => {
    mountApp();
    expect(lastBrowserSuppression()).toBe(false);
    expect(terminalVisibility()).toEqual({ visible: true, reasons: [] });

    let decision!: Promise<unknown>;
    act(() => {
      decision = useOrchestrationModeStore.getState().ask({
        title: 'Executar plano',
        body: 'Escolha Pack ou Guiado para continuar.',
        storyCount: 3,
        recommended: 'pack',
        templateRequiredForPack: false,
      });
    });

    expect(dialogContaining('Executar plano')).not.toBeNull();
    expect(blockingLabels()).toMatch(MODE_REPORT);
    expect(terminalVisibility().visible).toBe(false);
    expect(currentScreenSnapshot().context).toMatch(MODE_REPORT);
    expect(lastBrowserSuppression()).toBe(true);

    await act(async () => {
      useOrchestrationModeStore.getState().decide(null);
      await decision;
    });

    expect(dialogContaining('Executar plano')).toBeNull();
    expect(blockingLabels()).not.toMatch(MODE_REPORT);
    expect(terminalVisibility()).toEqual({ visible: true, reasons: [] });
    expect(currentScreenSnapshot().context).not.toMatch(MODE_REPORT);
    expect(lastBrowserSuppression()).toBe(false);
  });

  it('mounts open Media as the reported blocking surface, suppresses the live browser pane, and restores both on close', () => {
    mountApp();
    expect(lastBrowserSuppression()).toBe(false);

    act(() => useMediaStudioStore.getState().show());

    expect(dialogContaining('Estúdio de Mídia')).not.toBeNull();
    expect(blockingLabels()).toMatch(MEDIA_REPORT);
    expect(terminalVisibility().visible).toBe(false);
    expect(currentScreenSnapshot().context).toMatch(MEDIA_REPORT);
    expect(lastBrowserSuppression()).toBe(true);

    act(() => useMediaStudioStore.getState().hide());

    expect(dialogContaining('Estúdio de Mídia')).toBeNull();
    expect(blockingLabels()).not.toMatch(MEDIA_REPORT);
    expect(terminalVisibility()).toEqual({ visible: true, reasons: [] });
    expect(currentScreenSnapshot().context).not.toMatch(MEDIA_REPORT);
    expect(lastBrowserSuppression()).toBe(false);
  });

  it('mounts profileOpen as visible DOM, reports it only while mounted, and suppresses the live browser pane', () => {
    mountApp();
    expect(lastBrowserSuppression()).toBe(false);

    act(() => useGamificationStore.setState({ profileOpen: true }));

    const profile = dialogContaining('Perfil de Operador');
    expect(profile).not.toBeNull();
    expect(profile?.textContent).toContain('Operador em modo recruta');
    expect(blockingLabels()).toMatch(PROFILE_REPORT);
    expect(terminalVisibility().visible).toBe(false);
    expect(currentScreenSnapshot().context).toMatch(PROFILE_REPORT);
    expect(lastBrowserSuppression()).toBe(true);

    act(() => useGamificationStore.getState().closeProfile());

    expect(dialogContaining('Perfil de Operador')).toBeNull();
    expect(blockingLabels()).not.toMatch(PROFILE_REPORT);
    expect(terminalVisibility()).toEqual({ visible: true, reasons: [] });
    expect(currentScreenSnapshot().context).not.toMatch(PROFILE_REPORT);
    expect(lastBrowserSuppression()).toBe(false);
  });
});
