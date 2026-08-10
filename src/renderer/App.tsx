import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  detachWorkspaceLayout,
  switchWorkspaceLayoutWithFallback,
  useLayoutStore,
} from './state/layout-store';
import { VoiceHud } from './components/VoiceHud';
import { VoiceSettings } from './components/VoiceSettings';
import {
  CloseWorkspaceDialog,
  useCloseWorkspaceStore,
} from './components/CloseWorkspaceDialog';
import { CommandPalette } from './components/CommandPalette';
import { useCommandPaletteStore } from './state/command-palette-store';
import { ConfirmDialog } from './components/ConfirmDialog';
import { OverlayLayer } from './overlay/overlay-layer';
import { OrchestrationModeDialog } from './components/OrchestrationModeDialog';
import { MediaStudioPanel } from './components/MediaStudioPanel';
import { OperatorProfile } from './components/OperatorProfile';
import { useOrchestrationModeStore } from './state/orchestration-mode-store';
import { useMediaStudioStore } from './state/media-studio-store';
import { useConfirmStore } from './state/confirm-store';
import { useToastStore } from './state/toast-store';
import { missionBlockCauseText } from '../shared/mission-block-cause';
import { KeyboardCheatsheet } from './components/KeyboardCheatsheet';
import { useCheatsheetStore } from './state/cheatsheet-store';
import { useVoiceController } from './voice/voice-controller';
import { useOrchBridge } from './orch/orch-bridge';
import { initDevServerStore } from './state/dev-server-store';
import { initDesignSelectionStore } from './state/design-selection-store';
import { useOrchStore } from './state/orch-store';
import { useSettingsController } from './state/settings-store';
import { useWorkspaceController, useWorkspaceStore } from './state/workspace-store';
import { useProviderController } from './state/provider-store';
import { reconcileHosts } from './terminal/terminal-host';
import {
  gateRestoredAgents,
  resetRestoredAgentsGate,
} from './orch/restore-agents-gate';
import {
  reconcileBrowserPanes,
  setBrowserPaneSuppression,
} from './browser/browser-host';
import { listPanes } from './lib/split-tree';
import { routeMissionAttention } from './lib/mission-attention-route';
import { useFilesStore } from './state/files-store';
import { useAccountController } from './state/account-store';
import { useCostController } from './state/cost-store';
import { useUsageSync } from './state/usage-store';
import { useQuotaSync } from './state/quota-store';
import {
  useGamificationStore,
  useGamificationSync,
} from './state/gamification-store';
import { useFailoverController } from './orch/failover-controller';
import { useAccountRestartController } from './orch/account-restart-controller';
import { Toasts } from './components/Toasts';
import { useVoiceStore } from './voice/voice-store';
import { requestPaneClose } from './terminal/pane-close-guard';
import { NexusMark } from './components/NexusMark';
import { PixelIcon } from './components/PixelIcon';
import {
  ContextualPanel,
  type ContextualPanelFocusTarget,
} from './components/ContextualPanel';
import {
  EditorPanelBody,
  MarketplacePanelBody,
  MemoryPanelBody,
  SearchPanelBody,
  SkillsPanelBody,
} from './components/product/ProductPanelBodies';
import { filesFromClipboardData } from './lib/mission-attachments';
import { MissionJournalPanel } from './components/product/MissionJournalPanel';
import { FanoutComparePanel } from './components/FanoutComparePanel';
import { GitPanelBody } from './components/GitPanelBody';
import { applyProgressiveLaunchIfPending } from './lib/progressive-launch';
import { useProductFlags } from './lib/use-product-flags';
import { FEATURE_FLAG_IDS } from '../shared/feature-flags';
import { bootGreeting } from '../shared/endorphin';
import { AppShell } from './components/product/AppShell';
import { Launcher } from './components/product/Launcher';
import {
  WorkspaceRail,
  type WorkspaceRailSelection,
} from './components/product/WorkspaceRail';
import { MissionSetup } from './components/mission/MissionSetup';
import { MissionBoard } from './components/mission/MissionBoard';
import { TerminalWorkspace } from './components/product/TerminalWorkspace';
import { TaskBoardWorkspace } from './components/product/TaskBoardWorkspace';
import { MemoryWorkspace } from './components/product/MemoryWorkspace';
import { SettingsWorkspace } from './components/settings/SettingsWorkspace';
import { AgentNotifications } from './components/AgentNotifications';
import {
  useProductNavigationStore,
  type ProductDestination,
} from './state/product-navigation-store';
import {
  normalizeProjectContextPath,
  useMissionSetupStore,
} from './state/mission-setup-store';
import {
  DEFAULT_CONTEXTUAL_PANEL,
  type ContextualPanelState,
  type ContextualTab,
} from '../shared/contextual-panel';

const TERMINAL_CONTEXTUAL_TABS: readonly ContextualTab[] = [
  'mission',
  'editor',
  'git',
  'search',
  'skills',
  'marketplace',
  'memory',
];

/** Primeiro hit de endorfina: marca + cumprimento vivo enquanto os sistemas ligam. */
function BootScreen() {
  return (
    <div className="boot" role="status" aria-live="polite">
      <div className="boot__inner">
        <div className="boot__ring" aria-hidden="true">
          <NexusMark size={30} className="boot__mark" />
        </div>
        <span className="boot__greet">{bootGreeting()}</span>
        <span className="boot__label">Ligando instrumentos</span>
      </div>
    </div>
  );
}

function droppedProjectContextPath(
  workspacePath: string,
  file: File,
): string | null {
  const absolutePath = window.nexus.files.pathForFile(file);
  if (!absolutePath) return null;

  const root = workspacePath.replaceAll('\\', '/').replace(/\/+$/u, '');
  const candidate = absolutePath.replaceAll('\\', '/');
  const caseInsensitive = /^[A-Za-z]:\//u.test(root);
  const comparableRoot = caseInsensitive ? root.toLowerCase() : root;
  const comparableCandidate = caseInsensitive
    ? candidate.toLowerCase()
    : candidate;
  const prefix = `${comparableRoot}/`;
  if (!comparableCandidate.startsWith(prefix)) return null;
  return normalizeProjectContextPath(candidate.slice(root.length + 1));
}

function productDestinationKey(destination: ProductDestination): string {
  if (destination.kind === 'mission') {
    return `${destination.kind}:${destination.missionId}:${destination.surface}`;
  }
  if (destination.kind === 'settings') {
    return `${destination.kind}:${destination.section ?? ''}`;
  }
  return destination.kind;
}

function productDestinationLabel(destination: ProductDestination): string {
  switch (destination.kind) {
    case 'launcher':
      return 'Launcher';
    case 'terminal':
      return 'Terminal do workspace';
    case 'mission-setup':
      return 'Preparar missão';
    case 'mission':
      return destination.surface === 'board'
        ? 'Quadro da missão'
        : 'Terminais da missão';
    case 'task-board':
      return 'Quadro de tarefas';
    case 'memory':
      return 'Memória do projeto';
    case 'settings':
      return 'Configurações';
  }
}

function outgoingSurfaceOwnsFocus(active: Element | null): boolean {
  if (!(active instanceof HTMLElement)) return false;
  if (active.closest('[data-preserve-destination-focus="true"]')) return false;
  if (active.closest('aside.workspace-rail')) return false;
  if (active.closest('aside.product-inspector')) return true;
  const canvas = active.closest('main.product-canvas');
  if (canvas && active !== canvas) return true;
  return Boolean(
    active.closest('[role="dialog"], .nexus-shell__overlays'),
  );
}

/**
 * App root: hydrates the saved layout on boot and wires global keyboard
 * shortcuts (split/close) against the currently focused pane.
 */
export function App() {
  const productFlags = useProductFlags();
  const hydrated = useLayoutStore((state) => state.hydrated);
  const layoutRoot = useLayoutStore((state) => state.root);
  const workspaceHydrated = useWorkspaceStore((state) => state.hydrated);
  const currentWorkspace = useWorkspaceStore((state) => state.current);
  const recentWorkspaces = useWorkspaceStore((state) => state.recents);
  const destination = useProductNavigationStore((state) => state.destination);
  const missionSummaries = useOrchStore((state) => state.missionSummaries);
  const closeWorkspaceOpen = useCloseWorkspaceStore((state) => state.open);
  const voiceSettingsOpen = useVoiceStore((state) => state.settingsOpen);
  const paletteOpen = useCommandPaletteStore((state) => state.open);
  const confirmOpen = useConfirmStore((state) => state.pending !== null);
  const cheatsheetOpen = useCheatsheetStore((state) => state.open);
  const orchestrationModeOpen = useOrchestrationModeStore(
    (state) => state.pending !== null,
  );
  const mediaStudioOpen = useMediaStudioStore((state) => state.open);
  const closeMediaStudio = useMediaStudioStore((state) => state.hide);
  const operatorProfileOpen = useGamificationStore(
    (state) => state.profileOpen,
  );
  const [dropActive, setDropActive] = useState(false);
  const [contextualPanelState, setContextualPanelState] =
    useState<ContextualPanelState>(DEFAULT_CONTEXTUAL_PANEL);
  const [
    contextualPanelFocusTarget,
    setContextualPanelFocusTarget,
  ] = useState<ContextualPanelFocusTarget | null>(null);
  const [destinationFocusRequest, setDestinationFocusRequest] = useState(0);

  const terminalBearing =
    destination.kind === 'terminal' ||
    (destination.kind === 'mission' &&
      destination.surface === 'terminals');
  const hardOverlayOpen =
    closeWorkspaceOpen ||
    voiceSettingsOpen ||
    paletteOpen ||
    confirmOpen ||
    cheatsheetOpen ||
    orchestrationModeOpen ||
    mediaStudioOpen ||
    operatorProfileOpen;
  const suppressBrowserPanes = !terminalBearing || hardOverlayOpen;

  useVoiceController(workspaceHydrated && currentWorkspace !== null);
  useOrchBridge();
  useSettingsController();
  useWorkspaceController();
  useProviderController();
  useAccountController();
  useCostController();
  useUsageSync();
  useQuotaSync();
  useGamificationSync();
  useFailoverController();
  useAccountRestartController();

  useEffect(
    () =>
      useProductNavigationStore.subscribe((next, previous) => {
        if (
          productDestinationKey(next.destination) ===
          productDestinationKey(previous.destination)
        ) {
          return;
        }
        setContextualPanelFocusTarget(null);
        if (!outgoingSurfaceOwnsFocus(document.activeElement)) return;
        setDestinationFocusRequest((current) => current + 1);
      }),
    [],
  );

  // Each workspace owns its saved pane tree. A workspace identity change may
  // choose Terminal, but ordinary store refreshes never reset the active
  // product destination.
  const lastWorkspacePath = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    if (!workspaceHydrated) return;
    const path = currentWorkspace?.path ?? null;
    const previousPath = lastWorkspacePath.current;

    if (!path) {
      detachWorkspaceLayout();
      reconcileHosts(new Set());
      reconcileBrowserPanes(new Set());
      resetRestoredAgentsGate();
      useProductNavigationStore.getState().closeWorkspace();
      lastWorkspacePath.current = null;
      return;
    }

    const workspaceChanged = previousPath !== path;
    if (workspaceChanged) {
      useFilesStore.getState().reset();
      const navigation = useProductNavigationStore.getState();
      const activatingWorkspace = previousPath === null;
      const replacingWorkspace =
        previousPath !== undefined &&
        previousPath !== null &&
        previousPath !== path;
      if (
        navigation.destination.kind === 'launcher' ||
        activatingWorkspace ||
        replacingWorkspace
      ) {
        navigation.openTerminal();
      }
    }
    lastWorkspacePath.current = path;
    if (!workspaceChanged) return;

    const isCurrentWorkspace = () =>
      useWorkspaceStore.getState().current?.path === path;
    void switchWorkspaceLayoutWithFallback(path, {
      isCurrent: isCurrentWorkspace,
    })
      .then(() => {
        if (!isCurrentWorkspace()) return;
        void gateRestoredAgents(
          listPanes(useLayoutStore.getState().root),
        );
      })
      .catch(() => {
        if (!isCurrentWorkspace()) return;
        useToastStore.getState().push(
          'error',
          'Layout não pôde ser restaurado',
          'Abri um terminal seguro sem sobrescrever o layout salvo. Reabra o workspace para tentar novamente.',
        );
      });
  }, [workspaceHydrated, currentWorkspace]);

  useEffect(() => {
    if (!workspaceHydrated || !currentWorkspace || !hydrated) return;
    const liveIds = new Set(listPanes(layoutRoot).map((pane) => pane.id));
    reconcileHosts(liveIds);
    reconcileBrowserPanes(liveIds);
  }, [
    workspaceHydrated,
    currentWorkspace,
    hydrated,
    layoutRoot,
  ]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (useConfirmStore.getState().pending) return;
      if (document.querySelector('[role="dialog"][aria-modal="true"]')) return;
      const mod = event.metaKey || event.ctrlKey;
      if (!mod) return;

      if (event.key === ',') {
        event.preventDefault();
        useProductNavigationStore.getState().openSettings();
        return;
      }
      if (
        event.key.toLowerCase() === 'o' &&
        event.shiftKey &&
        !event.altKey
      ) {
        event.preventDefault();
        useProductNavigationStore.getState().openSettings('account');
        return;
      }
      if (
        event.key.toLowerCase() === 'b' &&
        !event.shiftKey &&
        !event.altKey
      ) {
        // Launcher exposes the same canonical empty Task Board destination.
        event.preventDefault();
        useProductNavigationStore.getState().openTaskBoard();
        return;
      }
      if (
        event.key.toLowerCase() === 'k' &&
        !event.shiftKey &&
        !event.altKey
      ) {
        if (!useWorkspaceStore.getState().current) return;
        event.preventDefault();
        useCommandPaletteStore.getState().toggle();
        return;
      }
      if (event.key === '/' && !event.shiftKey && !event.altKey) {
        event.preventDefault();
        useCheatsheetStore.getState().toggle();
        return;
      }
      if (
        event.key.toLowerCase() === 'n' &&
        !event.shiftKey &&
        !event.altKey
      ) {
        event.preventDefault();
        useMissionSetupStore.getState().clearEntryContext();
        useMissionSetupStore
          .getState()
          .setWorkspace(useWorkspaceStore.getState().current?.path ?? null);
        useMissionSetupStore.getState().setStep('mission');
        useProductNavigationStore.getState().openMissionSetup();
        return;
      }
      if (
        !event.shiftKey &&
        !event.altKey &&
        event.key >= '1' &&
        event.key <= '9'
      ) {
        const layout = useLayoutStore.getState();
        const pane = listPanes(layout.root)[Number(event.key) - 1];
        if (pane) {
          event.preventDefault();
          const navigation = useProductNavigationStore.getState();
          if (pane.missionId) {
            navigation.openMission(pane.missionId);
            useProductNavigationStore.getState().showMissionTerminals();
          } else {
            navigation.openTerminal();
          }
          layout.focus(pane.id);
        }
        return;
      }

      const layout = useLayoutStore.getState();
      if (!layout.focusedPaneId) return;
      const key = event.key.toLowerCase();
      if (key === 'd' && layout.viewKind === 'grid') {
        event.preventDefault();
        useProductNavigationStore.getState().openTerminal();
        layout.split(
          layout.focusedPaneId,
          event.shiftKey ? 'column' : 'row',
        );
      } else if (key === 'w') {
        event.preventDefault();
        requestPaneClose(layout.focusedPaneId);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Finder drops become canonical, root-relative project context. External
  // files are never staged into an unreviewed absolute-path mission contract.
  useEffect(() => {
    const hasFiles = (event: DragEvent) =>
      Array.from(event.dataTransfer?.types ?? []).includes('Files');
    const onDragOver = (event: DragEvent) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      setDropActive(true);
    };
    const onDragLeave = (event: DragEvent) => {
      if (event.relatedTarget === null) setDropActive(false);
    };
    const onDrop = (event: DragEvent) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      setDropActive(false);
      const workspace = useWorkspaceStore.getState().current;
      if (!workspace) return;
      const files = filesFromClipboardData(event.dataTransfer);
      if (files.length === 0) return;

      const contextPaths = files.flatMap((file) => {
        const path = droppedProjectContextPath(workspace.path, file);
        return path ? [path] : [];
      });
      const setup = useMissionSetupStore.getState();
      setup.clearEntryContext();
      setup.setWorkspace(workspace.path);
      if (contextPaths.length > 0) {
        const current = useMissionSetupStore.getState();
        current.setContextPaths([
          ...current.draft.contextPaths,
          ...contextPaths,
        ]);
      } else {
        useToastStore.getState().push(
          'warn',
          'Arquivo fora do projeto',
          'Use arquivos que estejam dentro do workspace para anexá-los como contexto da missão.',
        );
      }
      useMissionSetupStore.getState().setStep('mission');
      useProductNavigationStore.getState().openMissionSetup();
    };
    window.addEventListener('dragover', onDragOver);
    window.addEventListener('dragleave', onDragLeave);
    window.addEventListener('drop', onDrop);
    return () => {
      window.removeEventListener('dragover', onDragOver);
      window.removeEventListener('dragleave', onDragLeave);
      window.removeEventListener('drop', onDrop);
    };
  }, []);

  useEffect(() => {
    setBrowserPaneSuppression('product-destination', suppressBrowserPanes);
  }, [suppressBrowserPanes]);

  useEffect(
    () => () => setBrowserPaneSuppression('product-destination', false),
    [],
  );

  useEffect(() => {
    if (!workspaceHydrated || !currentWorkspace || !hydrated) return;
    applyProgressiveLaunchIfPending();
  }, [workspaceHydrated, currentWorkspace, hydrated]);

  useEffect(() => {
    return window.nexus.app.onDeepOpenPath(({ path, isDir }) => {
      const workspacePath = isDir ? path : path.replace(/\/[^/]*$/u, '');
      if (workspacePath) {
        void useWorkspaceStore
          .getState()
          .open(workspacePath)
          .then(() => {
            if (
              useWorkspaceStore.getState().current?.path === workspacePath
            ) {
              useProductNavigationStore.getState().openTerminal();
            }
          });
      }
    });
  }, []);

  useEffect(() => initDevServerStore(), []);
  useEffect(() => initDesignSelectionStore(), []);

  useEffect(() => {
    const petApi = window.nexus.pet;
    if (!petApi) return;
    const offs: Array<() => void> = [];
    if (petApi.onOpenSettings) {
      offs.push(
        petApi.onOpenSettings(() => {
          useProductNavigationStore.getState().openSettings('appearance');
        }),
      );
    }
    if (petApi.onOpenOps) {
      offs.push(
        petApi.onOpenOps(() => {
          useProductNavigationStore.getState().openTaskBoard();
        }),
      );
    }
    if (petApi.onAttention) {
      offs.push(
        petApi.onAttention((event) => {
          const isBlock = event.kind === 'mission-blocked';
          const isTechnicalFailure =
            event.kind === 'mission-technical-failure';
          const isWait = event.kind === 'agent-waiting';
          const isDone = event.kind === 'mission-done';
          if (!isBlock && !isTechnicalFailure && !isWait && !isDone) return;
          const missionId = event.missionId;
          if (isDone) {
            const detail = `${event.title} — o resultado final foi validado.`;
            useToastStore.getState().push(
              'success',
              'Missão concluída',
              missionId
                ? {
                    detail,
                    action: {
                      label: 'Ver resultado',
                      onClick: () =>
                        routeMissionAttention({
                          missionId,
                          cause: 'completed',
                        }),
                    },
                    dedupeKey: `mission-completed:${missionId}`,
                  }
                : detail,
            );
            return;
          }

          const why = event.cause
            ? missionBlockCauseText({ ...event.cause, detail: null }, 150)
            : null;
          if (isTechnicalFailure) {
            useToastStore.getState().push('error', 'Falha técnica na missão', {
              detail: `${event.title} — ${
                why ??
                'a recuperação automática parou. Veja o diagnóstico para entender a causa e tentar novamente.'
              }`,
              action: {
                label: 'Ver diagnóstico',
                onClick: () => {
                  if (missionId) {
                    routeMissionAttention({
                      missionId,
                      cause: 'technical-failure',
                    });
                  } else {
                    useProductNavigationStore.getState().openTaskBoard();
                  }
                },
              },
              dedupeKey: `mission-technical-failure:${event.title}`,
            });
            return;
          }

          const multi = /·|\d+\s+(missões|agentes)/iu.test(event.title);
          const detail = multi
            ? `${event.title}. Abra o Quadro ou o pet.`
            : isBlock
              ? `${event.title} — ${
                  why ??
                  'Motivo não registrado. Abra a missão para ver o que aconteceu.'
                }`
              : `${event.title} — permissão ou resposta pendente no terminal.`;
          const humanDecision =
            event.cause?.code === 'human-decision' ||
            event.cause?.code === 'worker-decision' ||
            event.cause?.code === 'driver-block-human';
          useToastStore.getState().push(
            'warn',
            multi
              ? 'Várias coisas pedem você'
              : isBlock
                ? 'Missão precisa de você'
                : 'Agente pediu input',
            (isBlock || isWait) && !multi && missionId
              ? {
                  detail,
                  action: {
                    label: isBlock ? 'Abrir missão' : 'Responder',
                    onClick: () => {
                      routeMissionAttention({
                        missionId,
                        cause: isWait
                          ? 'human-input'
                          : humanDecision
                            ? 'human-question'
                            : 'technical-failure',
                      });
                    },
                  },
                  dedupeKey: `${event.kind}:${missionId}`,
                }
              : detail,
          );
        }),
      );
    }
    return () => {
      for (const off of offs) off();
    };
  }, []);

  function pickWorkspace(): void {
    void useWorkspaceStore
      .getState()
      .pick()
      .catch(() => {
        useToastStore.getState().push(
          'error',
          'Workspace não pôde ser aberto',
          'Escolha a pasta novamente.',
        );
      });
  }

  function selectWorkspace(workspaceId: string): void {
    const workspace = useWorkspaceStore.getState();
    if (workspace.current?.path === workspaceId) {
      useProductNavigationStore.getState().openTerminal();
      return;
    }
    void workspace.open(workspaceId).catch(() => {
      useToastStore.getState().push(
        'error',
        'Workspace não pôde ser aberto',
        'Tente abrir o projeto novamente pela lista de recentes.',
      );
    });
  }

  if (!workspaceHydrated) return <BootScreen />;
  if (currentWorkspace && !hydrated) return <BootScreen />;

  const navigation = useProductNavigationStore.getState();
  let destinationContent: ReactNode = null;
  switch (destination.kind) {
    case 'launcher':
      destinationContent = (
        <Launcher
          onOpenWorkspace={pickWorkspace}
          onStartMission={navigation.openMissionSetup}
          onOpenTaskBoard={navigation.openTaskBoard}
          onOpenMemory={navigation.openMemory}
        />
      );
      break;
    case 'terminal':
      break;
    case 'mission-setup':
      destinationContent = <MissionSetup />;
      break;
    case 'mission':
      if (destination.surface === 'board') {
        destinationContent = (
          <MissionBoard
            missionId={destination.missionId}
            onOpenTerminals={(missionId) => {
              const current = useProductNavigationStore.getState();
              if (
                current.destination.kind !== 'mission' ||
                current.destination.missionId !== missionId
              ) {
                current.openMission(missionId);
              }
              useProductNavigationStore.getState().showMissionTerminals();
            }}
          />
        );
      }
      break;
    case 'task-board':
      destinationContent = <TaskBoardWorkspace />;
      break;
    case 'memory':
      destinationContent = <MemoryWorkspace />;
      break;
    case 'settings':
      destinationContent = <SettingsWorkspace />;
      break;
  }

  const missionTerminal =
    destination.kind === 'mission' && destination.surface === 'terminals'
      ? destination
      : null;
  const content = currentWorkspace ? (
    <>
      <TerminalWorkspace
        hidden={!terminalBearing}
        missionId={missionTerminal?.missionId}
        onBackToBoard={
          missionTerminal
            ? () => useProductNavigationStore.getState().showMissionBoard()
            : undefined
        }
      />
      {terminalBearing ? null : destinationContent}
    </>
  ) : (
    destinationContent
  );

  const activeWorkspaces = currentWorkspace
    ? [
        {
          id: currentWorkspace.path,
          name: currentWorkspace.name,
          missions: missionSummaries.map((mission) => ({
            id: mission.id,
            title: mission.title,
            status: mission.state,
            needsAttention: mission.needsAttention,
          })),
        },
      ]
    : [];
  const projectedRecents = recentWorkspaces
    .filter((workspace) => workspace.path !== currentWorkspace?.path)
    .map((workspace) => ({
      id: workspace.path,
      name: workspace.name,
      missions: [],
    }));
  let selection: WorkspaceRailSelection = null;
  if (destination.kind === 'mission') {
    selection = { kind: 'mission', missionId: destination.missionId };
  } else if (destination.kind === 'task-board') {
    selection = { kind: 'task-board' };
  } else if (destination.kind === 'memory') {
    selection = { kind: 'memory' };
  } else if (destination.kind === 'settings') {
    selection = { kind: 'settings' };
  } else if (
    currentWorkspace &&
    (destination.kind === 'terminal' || destination.kind === 'mission-setup')
  ) {
    selection = {
      kind: 'workspace',
      workspaceId: currentWorkspace.path,
    };
  }

  const contextualPanelEnabled =
    productFlags[FEATURE_FLAG_IDS.contextualPanel] !== false;
  const contextualPanelVisible =
    contextualPanelEnabled &&
    contextualPanelState.workspaceId === currentWorkspace?.path &&
    contextualPanelState.visible;
  const contextualPanel =
    currentWorkspace && terminalBearing ? (
      <ContextualPanel
        key={currentWorkspace.path}
        flagEnabled={contextualPanelEnabled}
        workspaceId={currentWorkspace.path}
        initial={
          contextualPanelState.workspaceId === currentWorkspace.path
            ? contextualPanelState
            : {
                ...DEFAULT_CONTEXTUAL_PANEL,
                workspaceId: currentWorkspace.path,
              }
        }
        onStateChange={setContextualPanelState}
        placement={contextualPanelVisible ? 'inspector' : 'header'}
        focusTarget={contextualPanelFocusTarget}
        onFocusTargetChange={setContextualPanelFocusTarget}
        relevantTabs={TERMINAL_CONTEXTUAL_TABS}
        children={{
          search: <SearchPanelBody />,
          skills: <SkillsPanelBody />,
          marketplace: <MarketplacePanelBody />,
          editor: <EditorPanelBody />,
          memory: <MemoryPanelBody />,
          mission: (
            <>
              <FanoutComparePanel />
              <MissionJournalPanel />
            </>
          ),
          git: <GitPanelBody />,
        }}
      />
    ) : undefined;

  return (
    <div className="app">
      <AppShell
        rail={
          <WorkspaceRail
            activeWorkspaces={activeWorkspaces}
            recentWorkspaces={projectedRecents}
            selection={selection}
            onCreateNew={navigation.openMissionSetup}
            onSelectWorkspace={selectWorkspace}
            onSelectMission={(missionId) =>
              routeMissionAttention({
                missionId,
                cause: 'rail-selection',
              })
            }
            onOpenTaskBoard={navigation.openTaskBoard}
            onOpenMemory={navigation.openMemory}
            onOpenSettings={() => navigation.openSettings()}
          />
        }
        header={
          currentWorkspace ? (
            <>
              <AgentNotifications />
              {!contextualPanelVisible ? contextualPanel : null}
            </>
          ) : undefined
        }
        contentLabel={productDestinationLabel(destination)}
        focusRequest={destinationFocusRequest}
        content={content}
        inspector={
          contextualPanelVisible ? contextualPanel : undefined
        }
        overlays={
          <>
            <VoiceHud />
            <VoiceSettings />
            <CloseWorkspaceDialog />
            <OverlayLayer>
              {mediaStudioOpen ? (
                <MediaStudioPanel
                  open={mediaStudioOpen}
                  onClose={closeMediaStudio}
                />
              ) : null}
              {operatorProfileOpen ? <OperatorProfile /> : null}
              {orchestrationModeOpen ? <OrchestrationModeDialog /> : null}
              <CommandPalette />
              <KeyboardCheatsheet />
              <ConfirmDialog />
            </OverlayLayer>
            <Toasts />
            {dropActive ? (
              <div
                className="global-drop-overlay"
                role="status"
                aria-live="polite"
              >
                <div className="global-drop-overlay__inner">
                  <PixelIcon name="files" size={20} />
                  <span>Solte para anexar contexto à missão</span>
                </div>
              </div>
            ) : null}
          </>
        }
      />
    </div>
  );
}
