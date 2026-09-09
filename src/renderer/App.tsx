import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  detachWorkspaceLayout,
  switchWorkspaceLayoutWithFallback,
  useLayoutStore,
} from './state/layout-store';
import { VoiceHud } from './components/VoiceHud';
import { VoiceSettings } from './components/VoiceSettings';
import { DictationModeChip } from './components/DictationModeChip';
import {
  CloseWorkspaceDialog,
  useCloseWorkspaceStore,
} from './components/CloseWorkspaceDialog';
import { CommandPalette } from './components/CommandPalette';
import { useCommandPaletteStore } from './state/command-palette-store';
import { ConfirmDialog } from './components/ConfirmDialog';
import { TerminalGridDialog } from './components/TerminalGridDialog';
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
import { useAdapterController } from './state/adapter-store';
import { reconcileHosts } from './terminal/terminal-host';
import { resetRestoredAgentsGate } from './orch/restore-agents-gate';
import {
  reconcileBrowserPanes,
  setBrowserPaneSuppression,
} from './browser/browser-host';
import { listPanes } from './lib/split-tree';
import { describeWorkspaceOpenError } from './lib/workspace-open-error';
import {
  attentionCauseForMissionState,
  routeMissionAttention,
} from './lib/mission-attention-route';
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
import { removeMissionVerified } from './orch/remove-mission-verified';
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
import { stageMissionAttachment } from './lib/mission-attachments';
import {
  partitionDroppedMissionFiles,
  shellClaimsMissionFileDrop,
} from './lib/mission-shell-file-intake';
import { MissionJournalPanel } from './components/product/MissionJournalPanel';
import { FanoutComparePanel } from './components/FanoutComparePanel';
import { GitPanelBody } from './components/GitPanelBody';
import { applyProgressiveLaunchIfPending } from './lib/progressive-launch';
import { useProductFlags } from './lib/use-product-flags';
import { FEATURE_FLAG_IDS } from '../shared/feature-flags';
import { bootGreeting } from '../shared/endorphin';
import { missionAwaitsOperatorReview } from '../shared/mission-recovery-policy';
import { AppShell } from './components/product/AppShell';
import {
  WorkspaceRail,
  type WorkspaceRailSelection,
} from './components/product/WorkspaceRail';
import { projectRailWorkspaces } from './components/product/rail-workspaces';
import { MissionSetup } from './components/mission/MissionSetup';
import { MissionBoard } from './components/mission/MissionBoard';
import { TerminalWorkspace } from './components/product/TerminalWorkspace';
import { ProjectOverviewConnected } from './components/product/ProjectOverview';
import { TaskBoardWorkspace } from './components/product/TaskBoardWorkspace';
import { MemoryWorkspace } from './components/product/MemoryWorkspace';
import { SettingsWorkspace } from './components/settings/SettingsWorkspace';
import { AgentNotifications } from './components/AgentNotifications';
import { AttentionInbox } from './components/AttentionInbox';
import { useAttentionInboxStore } from './state/attention-inbox-store';
import { UpdateNotifier } from './components/UpdateModal';
import {
  useProductNavigationStore,
  type ProductDestination,
} from './state/product-navigation-store';
import {
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
    case 'mission-setup':
      return 'Criar com IA';
    case 'terminal':
      return 'Terminal do workspace';
    case 'project':
      return 'Projeto';
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
  const currentWorkspaceMissing = useWorkspaceStore(
    (state) => state.currentMissing,
  );
  const recentWorkspaces = useWorkspaceStore((state) => state.recents);
  const destination = useProductNavigationStore((state) => state.destination);
  const missionSummaries = useOrchStore((state) => state.missionSummaries);
  const missionSummariesHydrated = useOrchStore(
    (state) => state.missionSummariesHydrated,
  );
  const orchWorkspacePath = useOrchStore(
    (state) => state.boundWorkspacePath,
  );
  const orchMissions = useOrchStore((state) => state.missions);
  const crossWorkspaceSummaries = useOrchStore(
    (state) => state.crossWorkspaceSummaries,
  );
  const closeWorkspaceOpen = useCloseWorkspaceStore((state) => state.open);
  const voiceSettingsOpen = useVoiceStore((state) => state.settingsOpen);
  const paletteOpen = useCommandPaletteStore((state) => state.open);
  const confirmOpen = useConfirmStore((state) => state.pending !== null);
  const cheatsheetOpen = useCheatsheetStore((state) => state.open);
  // Precisa ficar AQUI, com os demais hooks: abaixo há dois early returns de
  // BootScreen, e um hook depois deles muda a contagem entre renders
  // ("Rendered more hooks than during the previous render") — tela branca no
  // primeiro boot, quando workspaceHydrated ainda é false.
  const attentionCount = useAttentionInboxStore((s) => s.count);
  /**
   * Clicar numa missão no rail abre a aba que responde o estado dela: entrega
   * concluída no Resultado, pergunta pendente na Conversa, falha na
   * Atividade. Antes era sempre Atividade.
   */
  const railAttentionCause = (missionId: string) =>
    attentionCauseForMissionState(
      useOrchStore
        .getState()
        .missionSummaries.find((mission) => mission.id === missionId)?.state,
    );
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
  // Pasta do projeto sumiu do disco (worktree removido por fora): o toast
  // diz o que houve e oferece a saída; a store já marcou o rail/cabeçalho.
  useWorkspaceController((event) => {
    const toast = useToastStore.getState();
    const dedupeKey = `workspace-missing:${event.path}`;
    if (event.missing) {
      toast.push('error', 'A pasta do projeto sumiu do disco', {
        detail:
          `“${event.name}” não existe mais em ${event.path}. Panes novos não ` +
          'abrem ali — abra outra pasta, ou recrie o worktree e reabra o projeto.',
        action: { label: 'Abrir outra pasta', onClick: () => pickWorkspace() },
        dedupeKey,
        ttlMs: 60_000,
      });
      return;
    }
    toast.push('success', 'A pasta do projeto voltou', {
      detail: `“${event.name}” está de volta em ${event.path}.`,
      dedupeKey,
    });
  });
  useProviderController();
  useAdapterController();
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

  // Flag-off / Labs kill-switch: orphan `project` destinations fall back to
  // Terminal so the rail item disappearing never leaves a dead surface.
  useEffect(() => {
    if (productFlags[FEATURE_FLAG_IDS.uiProjectOverview] !== false) return;
    if (destination.kind !== 'project') return;
    useProductNavigationStore.getState().openTerminal();
  }, [destination.kind, productFlags]);

  // A newly created mission can open before its first broadcast. Reconcile
  // on canonical refreshes, not navigation changes against an older list.
  useEffect(() => {
    if (
      !missionSummariesHydrated ||
      orchWorkspacePath !== currentWorkspace?.path
    ) return;
    const navigation = useProductNavigationStore.getState();
    const isMissing = (target: ProductDestination | null): boolean =>
      target?.kind === 'mission' &&
      !missionSummaries.some((mission) => mission.id === target.missionId);
    if (isMissing(navigation.destination)) {
      navigation.openLauncher();
    } else if (isMissing(navigation.settingsReturnDestination)) {
      useProductNavigationStore.setState({
        settingsReturnDestination: { kind: 'launcher' },
      });
    }
  }, [missionSummaries, missionSummariesHydrated, orchWorkspacePath, currentWorkspace?.path]);

  // Rail multi-workspace (2026-08-17): missão ativa em workspace vizinho
  // precisa aparecer enquanto o operador está em outro lugar. Refresca quando
  // os recentes mudam e a cada 60s (missões mudam de estado em background).
  const recentWorkspaceKey = recentWorkspaces
    .filter((workspace) => workspace.path !== currentWorkspace?.path)
    .map((workspace) => workspace.path)
    .join('|');
  useEffect(() => {
    const paths = recentWorkspaceKey ? recentWorkspaceKey.split('|') : [];
    const refresh = (): void => {
      const activePath = useWorkspaceStore.getState().current?.path;
      void useOrchStore
        .getState()
        .hydrateCrossWorkspace(paths.filter((path) => path !== activePath));
    };
    refresh();
    const timer = setInterval(refresh, 60_000);
    return () => clearInterval(timer);
  }, [recentWorkspaceKey]);

  // Restore each workspace's panes without replacing the creation home with
  // Terminal. Only a mission tied to the outgoing project needs a safe exit.
  const pendingMissionRemovals = useRef(new Set<string>());
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
      const replacingWorkspace =
        previousPath !== undefined &&
        previousPath !== null &&
        previousPath !== path;
      if (replacingWorkspace && navigation.destination.kind === 'mission') {
        navigation.openLauncher();
      } else if (
        replacingWorkspace &&
        navigation.settingsReturnDestination?.kind === 'mission'
      ) {
        useProductNavigationStore.setState({
          settingsReturnDestination: { kind: 'launcher' },
        });
      }
    }
    lastWorkspacePath.current = path;
    if (!workspaceChanged) return;

    const isCurrentWorkspace = () =>
      useWorkspaceStore.getState().current?.path === path;
    // The layout restore handler gates only panes read from disk. Reading the
    // live tree after this promise settles also catches newly created agents.
    void switchWorkspaceLayoutWithFallback(path, {
      isCurrent: isCurrentWorkspace,
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
        event.key.toLowerCase() === 'g' &&
        !event.shiftKey &&
        !event.altKey
      ) {
        if (!useWorkspaceStore.getState().current) return;
        if (
          productFlags[FEATURE_FLAG_IDS.uiProjectOverview] === false
        ) {
          return;
        }
        event.preventDefault();
        useProductNavigationStore.getState().openProject();
        return;
      }
      if (
        event.key.toLowerCase() === 'k' &&
        !event.shiftKey &&
        !event.altKey
      ) {
        if (!useWorkspaceStore.getState().current) return;
        event.preventDefault();
        useAttentionInboxStore.getState().setOpen(false);
        useCommandPaletteStore.getState().toggle();
        return;
      }
      if (
        event.key.toLowerCase() === 'j' &&
        !event.shiftKey &&
        !event.altKey
      ) {
        if (!useWorkspaceStore.getState().current) return;
        event.preventDefault();
        useCommandPaletteStore.getState().close();
        useAttentionInboxStore.getState().toggle();
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
        useProductNavigationStore.getState().openNewMission();
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
  }, [productFlags]);

  // Ctrl/Cmd+Tab cicla panes (G6). Capture-phase: o listener precisa ver a
  // tecla ANTES do xterm — no bubble o xterm escreveria 	 no PTY e o pane
  // cicaria junto. Mod+Tab no macOS é do SO (nunca chega); Ctrl+Tab cobre.
  useEffect(() => {
    const onCycleKey = (event: KeyboardEvent) => {
      if (event.key !== 'Tab') return;
      if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
      if (useConfirmStore.getState().pending) return;
      if (document.querySelector('[role="dialog"][aria-modal="true"]')) return;
      const target = event.target as HTMLElement | null;
      if (
        target?.closest('input, textarea, [contenteditable="true"]')
      ) {
        return; // settings/paleta: Tab aqui é navegação de campo
      }
      const layout = useLayoutStore.getState();
      const panes = listPanes(layout.root);
      if (panes.length < 2) return;
      event.preventDefault();
      event.stopPropagation();
      const currentIdx = panes.findIndex((p) => p.id === layout.focusedPaneId);
      const dir = event.shiftKey ? -1 : 1;
      const next =
        panes[(currentIdx + dir + panes.length) % panes.length] ?? panes[0]!;
      const navigation = useProductNavigationStore.getState();
      if (next.missionId) {
        navigation.openMission(next.missionId);
        useProductNavigationStore.getState().showMissionTerminals();
      } else {
        navigation.openTerminal();
      }
      layout.focus(next.id);
    };
    window.addEventListener('keydown', onCycleKey, { capture: true });
    return () =>
      window.removeEventListener('keydown', onCycleKey, { capture: true });
  }, []);

  // Finder drops on launcher/setup become mission context. An open pane or
  // mission keeps the event — claiming it here used to bounce the operator
  // back to Express with "Arquivo fora do projeto".
  useEffect(() => {
    const hasFiles = (event: DragEvent) =>
      Array.from(event.dataTransfer?.types ?? []).includes('Files');
    const onDragOver = (event: DragEvent) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      const destination = useProductNavigationStore.getState().destination;
      setDropActive(shellClaimsMissionFileDrop(destination.kind));
    };
    const onDragLeave = (event: DragEvent) => {
      if (event.relatedTarget === null) setDropActive(false);
    };
    const onDrop = (event: DragEvent) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      setDropActive(false);
      const destination = useProductNavigationStore.getState().destination;
      if (!shellClaimsMissionFileDrop(destination.kind)) {
        return;
      }
      event.stopPropagation();

      const workspace = useWorkspaceStore.getState().current;
      if (!workspace) return;
      // Arquivos CRUS do drop: o filtro de clipboard descartava PDF/documento
      // em silêncio ("arrastei e não ficou anexado", 19/08). A partição decide
      // o destino e o que ela rejeitar ganha um toast — nunca silêncio.
      const files = Array.from(event.dataTransfer?.files ?? []);
      if (files.length === 0) return;

      const split = partitionDroppedMissionFiles(workspace.path, files);
      if (split.rejected.length > 0) {
        useToastStore.getState().push(
          'warn',
          'Anexo não suportado no wizard',
          `${split.rejected
            .map((item) => item.name.trim() || 'anexo')
            .slice(0, 4)
            .join(', ')} — use imagem, áudio, documento (PDF/Office) ou texto/código.`,
        );
      }
      const setup = useMissionSetupStore.getState();
      if (destination.kind === 'launcher') {
        setup.clearEntryContext();
        setup.setWorkspace(workspace.path);
        setup.setStep('express');
        useProductNavigationStore.getState().openMissionSetup();
      }

      void (async () => {
        const imported: string[] = [];
        for (const file of split.toImport) {
          try {
            imported.push((await stageMissionAttachment(file)).path);
          } catch (error) {
            useToastStore.getState().push(
              'warn',
              'Não foi possível anexar',
              error instanceof Error
                ? error.message
                : `Falha ao importar ${file.name}.`,
            );
          }
        }
        const contextPaths = [...split.inProject, ...imported];
        // Rejeitados e falhas de import já ganharam toast específico acima —
        // um segundo aviso genérico aqui era só ruído.
        if (contextPaths.length === 0) return;
        const current = useMissionSetupStore.getState();
        current.setContextPaths([
          ...current.draft.contextPaths,
          ...contextPaths,
        ]);
      })();
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
          useProductNavigationStore.getState().openSettings('pets');
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
            const detail = `${event.title} — o resultado final está pronto.`;
            useToastStore.getState().push(
              'success',
              'Missão pronta',
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
      .catch((cause: unknown) => {
        useToastStore.getState().push(
          'error',
          'Workspace não pôde ser aberto',
          describeWorkspaceOpenError(cause),
        );
      });
  }

  function selectWorkspace(workspaceId: string): void {
    const workspace = useWorkspaceStore.getState();
    if (workspace.current?.path === workspaceId) {
      useProductNavigationStore.getState().openLauncher();
      return;
    }
    void workspace.open(workspaceId).catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      const isMissing =
        message.includes('inaccessible') ||
        message.includes('invalid') ||
        message.includes('não foi encontrada') ||
        message.includes('ENOENT');
      useToastStore.getState().push(
        'error',
        'Workspace não pôde ser aberto',
        isMissing
          ? 'A pasta não existe mais no disco ou está inacessível. Você pode removê-la dos recentes no ícone de lixeira.'
          : `Erro ao abrir: ${message}`,
      );
    });
  }

  function removeWorkspace(workspaceId: string): void {
    const workspace = useWorkspaceStore.getState();
    const isCurrent = workspace.current?.path === workspaceId;
    const targetName =
      (isCurrent ? workspace.current?.name : null) ??
      workspace.recents.find((w) => w.path === workspaceId)?.name ??
      workspaceId;

    if (isCurrent) {
      useCloseWorkspaceStore.getState().ask();
      return;
    }

    void workspace
      .remove(workspaceId)
      .then(() => {
        useToastStore.getState().push(
          'info',
          'Workspace removido',
          `“${targetName}” foi removido da lista de recentes.`,
        );
      })
      .catch((err) => {
        useToastStore.getState().push(
          'error',
          'Erro ao remover workspace',
          err instanceof Error ? err.message : String(err),
        );
      });
  }

  function removeMissionFromRail(missionId: string, workspaceId: string): void {
    const key = JSON.stringify([workspaceId, missionId]);
    if (pendingMissionRemovals.current.has(key)) return;
    pendingMissionRemovals.current.add(key);
    const mission = [...activeWorkspaces, ...projectedRecents]
      .find((workspace) => workspace.id === workspaceId)
      ?.missions.find((entry) => entry.id === missionId);
    const title = mission?.title ?? 'missão';
    void (async () => {
      const { askConfirm } = await import('./state/confirm-store');
      const { removeMissionPrompt } = await import(
        './orch/mission-list-action'
      );
      const prompt = removeMissionPrompt({ title });
      const changingWorkspace = useWorkspaceStore.getState().current?.path !== workspaceId;
      const confirmed = await askConfirm({
        ...prompt,
        body: changingWorkspace
          ? `${prompt.body} Para acessar este projeto, as sessões do projeto atual serão encerradas.`
          : prompt.body,
        danger: true,
      });
      if (!confirmed) return;
      try {
        if (useWorkspaceStore.getState().current?.path !== workspaceId) {
          await useWorkspaceStore.getState().open(workspaceId);
        }
        // O main encerra o runtime (inclusive missão running) antes de apagar.
        const removed = await removeMissionVerified(missionId, workspaceId);
        if (!removed) {
          useToastStore
            .getState()
            .push('error', 'Não deu pra remover a missão', 'Tente de novo.');
          return;
        }
        useToastStore
          .getState()
          .push('info', 'Missão removida', `“${title}” e o histórico foram apagados.`);
      } catch (err) {
        useToastStore.getState().push(
          'error',
          'Não deu pra remover a missão',
          err instanceof Error ? err.message : String(err),
        );
      }
    })().finally(() => pendingMissionRemovals.current.delete(key));
  }

  if (!workspaceHydrated) return <BootScreen />;
  if (currentWorkspace && !hydrated) return <BootScreen />;

  const navigation = useProductNavigationStore.getState();
  let destinationContent: ReactNode = null;
  switch (destination.kind) {
    case 'launcher':
      destinationContent = <MissionSetup home />;
      break;
    case 'terminal':
      break;
    case 'project':
      destinationContent = <ProjectOverviewConnected />;
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

  const { activeWorkspaces, recentWorkspaces: projectedRecents } =
    projectRailWorkspaces({
      current: currentWorkspace
        ? { path: currentWorkspace.path, name: currentWorkspace.name }
        : null,
      recents: recentWorkspaces.map((workspace) => ({
        path: workspace.path,
        name: workspace.name,
      })),
      currentSummaries: missionSummaries,
      currentAwaitingReviewIds: orchMissions
        .filter((mission) => missionAwaitsOperatorReview(mission))
        .map((mission) => mission.id),
      crossWorkspaceSummaries,
    });
  const projectOverviewEnabled =
    productFlags[FEATURE_FLAG_IDS.uiProjectOverview] !== false;

  let selection: WorkspaceRailSelection = null;
  if (destination.kind === 'launcher') {
    selection = { kind: 'launcher' };
  } else if (
    destination.kind === 'terminal' ||
    (destination.kind === 'mission' && destination.surface === 'terminals')
  ) {
    selection = { kind: 'terminals' };
  } else if (destination.kind === 'mission') {
    selection = { kind: 'mission', missionId: destination.missionId };
  } else if (destination.kind === 'project' && projectOverviewEnabled) {
    selection = { kind: 'project' };
  } else if (destination.kind === 'task-board') {
    selection = { kind: 'task-board' };
  } else if (destination.kind === 'memory') {
    selection = { kind: 'memory' };
  } else if (destination.kind === 'settings') {
    selection = { kind: 'settings' };
  } else if (
    currentWorkspace &&
    (destination.kind === 'mission-setup' ||
      (destination.kind === 'project' && !projectOverviewEnabled))
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
            onCreateNew={navigation.openNewMission}
            onOpenLauncher={navigation.openLauncher}
            onOpenWorkspace={pickWorkspace}
            currentWorkspaceId={currentWorkspace?.path}
            currentWorkspaceMissing={currentWorkspaceMissing}
            attentionCount={attentionCount}
            onOpenAttention={() =>
              useAttentionInboxStore.getState().setOpen(true)
            }
            onSelectWorkspace={selectWorkspace}
            onRemoveWorkspace={removeWorkspace}
            onRemoveMission={removeMissionFromRail}
            onSelectMission={(missionId, workspaceId) => {
              // Missão de workspace VIZINHO: troca de workspace e só então
              // navega — antes a missão do outro workspace era invisível E
              // inalcançável pelo rail.
              if (
                workspaceId &&
                workspaceId !== useWorkspaceStore.getState().current?.path
              ) {
                void useWorkspaceStore
                  .getState()
                  .open(workspaceId)
                  .then(() => {
                    routeMissionAttention({
                      missionId,
                      cause: railAttentionCause(missionId),
                    });
                  })
                  .catch(() => {
                    useToastStore.getState().push(
                      'error',
                      'Workspace não pôde ser aberto',
                      'Tente abrir o projeto novamente pela lista de recentes.',
                    );
                  });
                return;
              }
              routeMissionAttention({
                missionId,
                cause: railAttentionCause(missionId),
              });
            }}
            projectEnabled={Boolean(currentWorkspace) && projectOverviewEnabled}
            onOpenProject={
              currentWorkspace && projectOverviewEnabled
                ? navigation.openProject
                : undefined
            }
            onOpenTerminals={() => {
              const current = useProductNavigationStore.getState().destination;
              if (current.kind === 'mission') {
                useProductNavigationStore.getState().showMissionTerminals();
                return;
              }
              useProductNavigationStore.getState().openTerminal();
            }}
            onOpenTaskBoard={navigation.openTaskBoard}
            onOpenMemory={navigation.openMemory}
            onOpenSettings={() => navigation.openSettings()}
            onOpenUsageQuota={() => navigation.openSettings('usage-quota')}
          />
        }
        header={
          <>
            <div className="product-header__identity">
              <strong className="product-header__name">
                {currentWorkspace?.name ?? 'Seu espaço'}
              </strong>
              {currentWorkspaceMissing ? (
                <span
                  className="product-header__missing"
                  title="A pasta deste projeto não existe mais no disco"
                >
                  pasta não encontrada
                </span>
              ) : null}
              <span className="product-header__destination">
                {productDestinationLabel(destination)}
              </span>
            </div>
            <div className="product-header__tools">
              <UpdateNotifier alwaysVisible />
              {currentWorkspace ? (
                <>
                  <AgentNotifications />
                  {!contextualPanelVisible ? contextualPanel : null}
                  <DictationModeChip />
                </>
              ) : null}
            </div>
          </>
        }
        contentLabel={productDestinationLabel(destination)}
        focusRequest={destinationFocusRequest}
        content={content}
        inspector={
          contextualPanelVisible ? contextualPanel : undefined
        }
        overlays={
          <>
            <CloseWorkspaceDialog />
            <OverlayLayer>
              <VoiceHud />
              <VoiceSettings />
              {mediaStudioOpen ? (
                <MediaStudioPanel
                  open={mediaStudioOpen}
                  onClose={closeMediaStudio}
                />
              ) : null}
              {operatorProfileOpen ? <OperatorProfile /> : null}
              {orchestrationModeOpen ? <OrchestrationModeDialog /> : null}
              <CommandPalette />
              <AttentionInbox />
              <KeyboardCheatsheet />
              <ConfirmDialog />
              <TerminalGridDialog />
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
