import { useEffect, useRef, useState } from 'react';
import {
  useLayoutStore,
  switchWorkspaceLayout,
  detachWorkspaceLayout,
} from './state/layout-store';
import { WorkspaceBar } from './components/WorkspaceBar';
import { PaneGrid } from './components/PaneGrid';
import { CanvasView } from './components/CanvasView';
import { VoiceHud } from './components/VoiceHud';
import { VoiceSettings } from './components/VoiceSettings';
import { OrchestrationPanel } from './components/OrchestrationPanel';
import { OmpRpcPanel } from './components/omp/OmpRpcPanel';
import { MemoryPanel } from './components/memory/MemoryPanel';
import { ConfigInventoryPanel } from './components/discovery/ConfigInventoryPanel';
import { MissionRail } from './components/MissionRail';
import { SettingsDrawer } from './components/settings/SettingsDrawer';
import { LaunchScreen } from './components/LaunchScreen';
import { HomeDeck } from './components/HomeDeck';
import { MissionWizard } from './components/MissionWizard';
import {
  CloseWorkspaceDialog,
  useCloseWorkspaceStore,
} from './components/CloseWorkspaceDialog';
import { CommandPalette } from './components/CommandPalette';
import { useCommandPaletteStore } from './state/command-palette-store';
import { ConfirmDialog } from './components/ConfirmDialog';
import { useConfirmStore } from './state/confirm-store';
import { useToastStore } from './state/toast-store';
import { KeyboardCheatsheet } from './components/KeyboardCheatsheet';
import { useCheatsheetStore } from './state/cheatsheet-store';
import { FilesPanel } from './components/FilesPanel';
import { OpsBoard } from './components/OpsBoard';
import { DiffAnnotatePanel } from './components/DiffAnnotatePanel';
import { IntegrationsPanel } from './components/IntegrationsPanel';
import { MediaStudioPanel } from './components/MediaStudioPanel';
import { useVoiceController } from './voice/voice-controller';
import { useOrchBridge } from './orch/orch-bridge';
import { initDevServerStore } from './state/dev-server-store';
import { initDesignSelectionStore } from './state/design-selection-store';
import { useOrchStore } from './state/orch-store';
import { useSettingsController, useSettingsStore } from './state/settings-store';
import { useWorkspaceController, useWorkspaceStore } from './state/workspace-store';
import { useProviderController } from './state/provider-store';
import { useMissionWizardStore } from './state/mission-wizard-store';
import { useHomeStore } from './state/home-store';
import { useIntegrationsStore } from './state/integrations-store';
import { useMediaStudioStore } from './state/media-studio-store';
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
import { useFilesStore } from './state/files-store';
import { useAccountController } from './state/account-store';
import { useCostController } from './state/cost-store';
import { useUsageSync } from './state/usage-store';
import { useQuotaSync } from './state/quota-store';
import { useGamificationSync, useGamificationStore } from './state/gamification-store';
import { OperatorProfile } from './components/OperatorProfile';
import { OperatorFx } from './components/OperatorFx';
import { MissionEndorphinFx } from './components/MissionEndorphinFx';
import { useOnboardingStore, useOnboardingSync } from './state/onboarding-store';
import { Onboarding } from './components/Onboarding';
import { useFailoverController } from './orch/failover-controller';
import { useAccountRestartController } from './orch/account-restart-controller';
import { Toasts } from './components/Toasts';
import { useVoiceStore } from './voice/voice-store';
import { UpdateNotifier } from './components/UpdateModal';
import { requestPaneClose } from './terminal/pane-close-guard';
import { NexusMark } from './components/NexusMark';
import { PixelIcon } from './components/PixelIcon';
import { ModeLauncher } from './components/ModeLauncher';
import { ContextualPanel } from './components/ContextualPanel';
import {
  EditorPanelBody,
  MarketplacePanelBody,
  McpHubPanelBody,
  MemoryPanelBody,
  SearchPanelBody,
  SkillsPanelBody,
} from './components/product/ProductPanelBodies';
import {
  clearDroppedFiles,
  enqueueDroppedFiles,
  filesFromClipboardData,
} from './lib/mission-attachments';
import { MissionJournalPanel } from './components/product/MissionJournalPanel';
import { FanoutComparePanel } from './components/FanoutComparePanel';
import { GitPanelBody } from './components/GitPanelBody';
import type { LAUNCHER_MODES } from '../shared/progressive-onboarding';
import type { ContextualTab } from '../shared/contextual-panel';
import { applyProgressiveLaunchIfPending } from './lib/progressive-launch';
import { useProductFlags } from './lib/use-product-flags';
import { FEATURE_FLAG_IDS } from '../shared/feature-flags';
import { bootGreeting } from '../shared/endorphin';

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

/**
 * App root: hydrates the saved layout on boot and wires global keyboard
 * shortcuts (split/close) against the currently focused pane.
 */
export function App() {
  const productFlags = useProductFlags();
  const hydrated = useLayoutStore((s) => s.hydrated);
  const viewKind = useLayoutStore((s) => s.viewKind);
  const workspaceHydrated = useWorkspaceStore((s) => s.hydrated);
  const currentWorkspace = useWorkspaceStore((s) => s.current);
  const settingsDrawerOpen = useSettingsStore((s) => s.drawerOpen);
  const missionWizardOpen = useMissionWizardStore((s) => s.open);
  const closeWorkspaceOpen = useCloseWorkspaceStore((s) => s.open);
  const voiceSettingsOpen = useVoiceStore((s) => s.settingsOpen);
  const opsBoardOpen = useOrchStore((s) => s.boardOpen);
  // Remonta o FX de endorfina por workspace — reseta as baselines de missão/
  // handoff no switch, senão o backlog do novo workspace seria "celebrado".
  const endorphinWorkspaceKey = useOrchStore((s) => s.boundWorkspacePath ?? '∅');
  const [diffOpen, setDiffOpen] = useState(false);
  const [dropActive, setDropActive] = useState(false);
  const integrationsOpen = useIntegrationsStore((s) => s.open);
  const mediaStudioOpen = useMediaStudioStore((s) => s.open);
  const onboardingVisible = useOnboardingStore(
    (s) => s.loaded && !s.state.completed && !s.state.skipped,
  );
  const operatorProfileOpen = useGamificationStore((s) => s.profileOpen);
  const paletteOpen = useCommandPaletteStore((s) => s.open);
  const confirmOpen = useConfirmStore((s) => s.pending !== null);
  const cheatsheetOpen = useCheatsheetStore((s) => s.open);
  const [launcherMode, setLauncherMode] = useState<
    (typeof LAUNCHER_MODES)[number]['id']
  >('terminal');
  const suppressBrowserPanes =
    settingsDrawerOpen ||
    missionWizardOpen ||
    closeWorkspaceOpen ||
    voiceSettingsOpen ||
    opsBoardOpen ||
    diffOpen ||
    integrationsOpen ||
    mediaStudioOpen ||
    onboardingVisible ||
    operatorProfileOpen ||
    paletteOpen ||
    confirmOpen ||
    cheatsheetOpen;

  useVoiceController();
  useOrchBridge();
  useSettingsController();
  useWorkspaceController();
  useProviderController();
  useAccountController();
  useCostController();
  useUsageSync();
  useQuotaSync();
  useGamificationSync();
  useOnboardingSync();
  useFailoverController();
  useAccountRestartController();

  // Each workspace owns its pane layout: entering one loads ITS saved tree;
  // leaving to the launcher detaches. A real mission layout restores silently;
  // anything that amounts to a single bare shell gets the Home deck instead
  // (see below).
  const lastWorkspacePath = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    if (!workspaceHydrated) return;
    const path = currentWorkspace?.path ?? null;
    if (!path) {
      detachWorkspaceLayout();
      // Closing the workspace terminates every live pane/session (the user was
      // warned). Disposing all hosts kills their PTYs.
      reconcileHosts(new Set());
      reconcileBrowserPanes(new Set());
      // Drop any in-flight "retomar agentes?" so a closed folder cannot answer
      // for the next one (same process, any OS).
      resetRestoredAgentsGate();
      lastWorkspacePath.current = path;
      return;
    }
    // A new workspace root invalidates the file tree cache.
    if (path !== lastWorkspacePath.current) useFilesStore.getState().reset();
    lastWorkspacePath.current = path;
    void switchWorkspaceLayout(path).then(() => {
      // Show the (non-modal) Home deck whenever what loaded is just a single
      // bare shell — a fresh folder AND a trivially-restored one look the same
      // to the user (an empty prompt), so both get the deck. A real mission
      // layout (agents, splits) restores the grid but does NOT auto-run agents
      // without confirmation (see restore-agents-gate).
      const panes = listPanes(useLayoutStore.getState().root);
      // Gate is also installed on layout restore; call again so App-path
      // restores that skipped the handler still pause agents.
      void gateRestoredAgents(panes);
      const loneBarShell =
        panes.length === 1 && panes[0].kind === 'shell' && !panes[0].orchRequestId;
      if (loneBarShell && !useMissionWizardStore.getState().open) {
        useHomeStore.getState().show();
      }
    });
  }, [workspaceHydrated, currentWorkspace]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Confirm pendente = modal: nenhum atalho global dispara por baixo do
      // dialog (cinto extra além do capture-stop do próprio ConfirmDialog).
      if (useConfirmStore.getState().pending) return;
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;
      // ⌘, — macOS-standard settings shortcut (works with no pane focused).
      if (e.key === ',') {
        e.preventDefault();
        useSettingsStore.getState().toggleDrawer();
        return;
      }
      // ⌘⇧O — Perfil de Operador. Funciona sempre, inclusive no modo sóbrio
      // (que esconde o HUD): sem isto, ativar o modo sóbrio trancaria a única
      // porta de volta ao perfil e à própria opção de desligá-lo.
      if (e.key.toLowerCase() === 'o' && e.shiftKey) {
        e.preventDefault();
        useGamificationStore.getState().toggleProfile();
        return;
      }
      // ⌘B — Ops Board (pipeline de missões). Só faz sentido num workspace.
      if (e.key.toLowerCase() === 'b' && !e.shiftKey && !e.altKey) {
        if (!useWorkspaceStore.getState().current) return;
        e.preventDefault();
        useOrchStore.getState().toggleBoard();
        return;
      }
      // ⌘K — command palette: panes, missões e ações a um teclado de distância.
      if (e.key.toLowerCase() === 'k' && !e.shiftKey && !e.altKey) {
        if (!useWorkspaceStore.getState().current) return;
        e.preventDefault();
        useCommandPaletteStore.getState().toggle();
        return;
      }
      // ⌘/ — cheatsheet de atalhos (ajuda no contexto, sem sair do fluxo).
      if (e.key === '/' && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        useCheatsheetStore.getState().toggle();
        return;
      }
      // ⌘⇧N — quick mission: cai direto no objetivo do Modo Agêntico, pulando
      // a seleção de modo. Para tarefas de uma linha ("roda esse teste").
      if (e.key.toLowerCase() === 'n' && e.shiftKey && !e.altKey) {
        if (!useWorkspaceStore.getState().current) return;
        e.preventDefault();
        useMissionWizardStore.getState().openForAgentic();
        return;
      }
      // ⌘N — nova missão (a ação primária merece o atalho primário).
      if (e.key.toLowerCase() === 'n' && !e.shiftKey && !e.altKey) {
        if (!useWorkspaceStore.getState().current) return;
        e.preventDefault();
        useMissionWizardStore.getState().openForMission();
        return;
      }
      // ⌘1-9 — foca o N-ésimo pane (ordem do grid). Frota sem mouse.
      if (!e.shiftKey && !e.altKey && e.key >= '1' && e.key <= '9') {
        const layout = useLayoutStore.getState();
        const panes = listPanes(layout.root);
        const pane = panes[Number(e.key) - 1];
        if (pane) {
          e.preventDefault();
          layout.focus(pane.id);
        }
        return;
      }
      const { focusedPaneId, split, viewKind: vk } = useLayoutStore.getState();
      if (!focusedPaneId) return;

      const key = e.key.toLowerCase();
      if (key === 'd' && vk === 'grid') {
        e.preventDefault();
        split(focusedPaneId, e.shiftKey ? 'column' : 'row');
      } else if (key === 'w') {
        e.preventDefault();
        requestPaneClose(focusedPaneId);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Global file drop: arrastou arquivo do Finder sobre o app → solte para
  // anexar à missão. O picker de anexos tem a própria dropzone; quando o
  // wizard está aberto ele é o alvo natural e o overlay global fica oculto.
  useEffect(() => {
    const hasFiles = (e: DragEvent) =>
      Array.from(e.dataTransfer?.types ?? []).includes('Files');
    const onDragOver = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      if (!useMissionWizardStore.getState().open) setDropActive(true);
    };
    const onDragLeave = (e: DragEvent) => {
      if (e.relatedTarget === null) setDropActive(false);
    };
    const onDrop = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      setDropActive(false);
      const target = e.target instanceof HTMLElement ? e.target : null;
      if (target?.closest('.mission-attachments')) return;
      if (useMissionWizardStore.getState().open) return;
      if (!useWorkspaceStore.getState().current) return;
      const files = filesFromClipboardData(e.dataTransfer);
      if (files.length === 0) return;
      enqueueDroppedFiles(files);
      useMissionWizardStore.getState().openForAgentic();
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

  // Se o wizard fechar antes do picker montar (Esc rápido), descarta os drops
  // pendentes para não anexarem à próxima missão aberta sem relação.
  useEffect(() => {
    if (!missionWizardOpen) clearDroppedFiles();
  }, [missionWizardOpen]);

  useEffect(() => {
    setBrowserPaneSuppression('modal-overlay', suppressBrowserPanes);
  }, [suppressBrowserPanes]);

  useEffect(() => {
    return () => setBrowserPaneSuppression('modal-overlay', false);
  }, []);

  // Progressive onboarding: apply stashed plan after workspace layout hydrates.
  useEffect(() => {
    if (!workspaceHydrated || !currentWorkspace || !hydrated) return;
    applyProgressiveLaunchIfPending();
  }, [workspaceHydrated, currentWorkspace, hydrated]);

  // Deep link nexus://open?path=… / abrir-com no Finder: abre o workspace
  // (diretório) ou o workspace-pai do arquivo. Validado no main (path absoluto).
  useEffect(() => {
    return window.nexus.app.onDeepOpenPath(({ path, isDir }) => {
      const wsPath = isDir ? path : path.replace(/\/[^/]*$/, '');
      if (wsPath) void useWorkspaceStore.getState().open(wsPath);
    });
  }, []);

  // Dev servers announced by PTYs and browser design selections are global
  // renderer subscriptions with explicit teardown on window unmount.
  useEffect(() => initDevServerStore(), []);
  useEffect(() => initDesignSelectionStore(), []);

  // Desktop pet → janela principal: Settings (Configurar…) e Ops Board
  // (missão pronta / precisa de intervenção — balão ou "Ver missões").
  useEffect(() => {
    // Preload changes require a full Electron restart while renderer changes
    // arrive through HMR. Keep optional desktop features from taking down the
    // entire app during that short version skew (or on an older installation).
    const petApi = window.nexus.pet;
    if (!petApi) return;
    const offs: Array<() => void> = [];
    if (petApi.onOpenSettings) {
      offs.push(
        petApi.onOpenSettings(() => {
          useSettingsStore.getState().openDrawer('appearance');
        }),
      );
    }
    if (petApi.onOpenOps) {
      offs.push(
        petApi.onOpenOps(() => {
          const orch = useOrchStore.getState();
          if (!orch.boardOpen) orch.toggleBoard();
          orch.openPanel('missions');
        }),
      );
    }
    // Eventos espelhados pelo main: intervencoes urgentes e conclusoes. O
    // companion continua mostrando seu balao; o toast garante confirmacao
    // visivel quando ele estiver desativado ou escondido atras de uma janela.
    if (petApi.onAttention) {
      offs.push(
        petApi.onAttention((event) => {
          const isBlock = event.kind === 'mission-blocked';
          const isWait = event.kind === 'agent-waiting';
          const isDone = event.kind === 'mission-done';
          if (!isBlock && !isWait && !isDone) return;
          if (isDone) {
            useToastStore.getState().push(
              'success',
              'Missão concluída',
              `${event.title} — o resultado final foi validado.`,
            );
            return;
          }
          const multi = /·|\d+\s+(missões|agentes)/i.test(event.title);
          useToastStore.getState().push(
            'warn',
            multi
              ? 'Várias coisas pedem você'
              : isBlock
                ? 'Missão precisa de você'
                : 'Agente pediu input',
            multi
              ? `${event.title}. Abra o Ops Board ou o pet.`
              : isBlock
                ? `${event.title} — travada aguardando decisão.`
                : `${event.title} — permissão/resposta pendente no terminal.`,
          );
        }),
      );
    }
    return () => {
      for (const off of offs) off();
    };
  }, []);

  if (!workspaceHydrated) {
    return <BootScreen />;
  }

  // No workspace open → onboarding launcher (first screen).
  // The wizard renders here too: "Novo workspace" starts from this screen.
  if (!currentWorkspace) {
    return (
      <div className="app">
        <LaunchScreen />
        {!suppressBrowserPanes && <VoiceHud />}
        <VoiceSettings />
        <SettingsDrawer />
        <MissionWizard />
        <OperatorProfile />
        <ConfirmDialog />
        <Toasts />
        <UpdateNotifier alwaysVisible />
      </div>
    );
  }

  // Workspace chosen but its layout still loading.
  if (!hydrated) {
    return <BootScreen />;
  }

  const ctxTabForMode = (
    id: (typeof LAUNCHER_MODES)[number]['id'],
  ): ContextualTab => {
    if (id === 'skills') return 'skills';
    if (id === 'marketplace') return 'marketplace';
    if (id === 'memory') return 'memory';
    if (id === 'missions' || id === 'swarm') return 'mission';
    // Activity stream é a superfície default: modo Terminal abre na aba Missão.
    if (id === 'terminal') return 'mission';
    return 'editor';
  };

  /** Tabs relevantes por modo — as demais ficam ocultas (auto-hide). */
  const relevantTabsForMode = (
    id: (typeof LAUNCHER_MODES)[number]['id'],
  ): readonly ContextualTab[] | undefined => {
    switch (id) {
      case 'terminal':
        return ['mission', 'search', 'editor', 'git', 'browser'];
      case 'missions':
      case 'swarm':
        return ['mission', 'handoff', 'git', 'search'];
      case 'board':
        return ['mission', 'handoff'];
      case 'memory':
        return ['memory', 'mission'];
      case 'skills':
        return ['skills', 'marketplace'];
      case 'marketplace':
        return ['marketplace', 'skills'];
      default:
        return undefined;
    }
  };

  const onModeSelect = (id: (typeof LAUNCHER_MODES)[number]['id']) => {
    setLauncherMode(id);
    if (id === 'missions') {
      useMissionWizardStore.getState().openForMission();
      return;
    }
    if (id === 'board') {
      const orch = useOrchStore.getState();
      if (!orch.boardOpen) orch.toggleBoard();
      return;
    }
    if (id === 'swarm') {
      useOrchStore.getState().openPanel('missions');
    }
  };

  return (
    <div className="app">
      <WorkspaceBar
        onOpenDiff={() => setDiffOpen(true)}
        onOpenIntegrations={() => useIntegrationsStore.getState().show()}
        onOpenMediaStudio={() => useMediaStudioStore.getState().show()}
      />
      <ModeLauncher activeId={launcherMode} onSelect={onModeSelect} />
      {/*
        Direct children of .app__body must stay: mission-rail, files, grid/canvas.
        Existing CSS (home-deck z-index, flex growth) targets those selectors.
        ContextualPanel is an extra flex sibling on the right.
      */}
      <main className="app__body app__body--with-ctx">
        <MissionRail />
        <FilesPanel />
        {viewKind === 'canvas' ? <CanvasView /> : <PaneGrid />}
        <HomeDeck />
        <OrchestrationPanel />
        <OmpRpcPanel />
        <MemoryPanel />
        <ConfigInventoryPanel />
        <ContextualPanel
          flagEnabled={productFlags[FEATURE_FLAG_IDS.contextualPanel] !== false}
          workspaceId={currentWorkspace?.path}
          activeTab={ctxTabForMode(launcherMode)}
          relevantTabs={relevantTabsForMode(launcherMode)}
          initial={{ visible: true }}
          children={{
            search: <SearchPanelBody />,
            skills: <SkillsPanelBody />,
            marketplace: <MarketplacePanelBody />,
            editor: <EditorPanelBody />,
            browser: <McpHubPanelBody />,
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
      </main>
      <OpsBoard />
      <DiffAnnotatePanel open={diffOpen} onClose={() => setDiffOpen(false)} />
      <IntegrationsPanel
        open={integrationsOpen}
        onClose={() => useIntegrationsStore.getState().hide()}
      />
      <MediaStudioPanel
        open={mediaStudioOpen}
        onClose={() => useMediaStudioStore.getState().hide()}
      />
      {!suppressBrowserPanes && <VoiceHud />}
      <VoiceSettings />
      <SettingsDrawer />
      <MissionWizard />
      <OperatorProfile />
      <OperatorFx />
      <MissionEndorphinFx key={endorphinWorkspaceKey} />
      <CloseWorkspaceDialog />
      <Onboarding />
      <CommandPalette />
      <KeyboardCheatsheet />
      <ConfirmDialog />
      <Toasts />
      {dropActive && (
        <div className="global-drop-overlay" role="status" aria-live="polite">
          <div className="global-drop-overlay__inner">
            <PixelIcon name="files" size={20} />
            <span>Solte para anexar à missão</span>
          </div>
        </div>
      )}
    </div>
  );
}
