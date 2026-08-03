import { useEffect, useRef, useState } from 'react';
import {
  useLayoutStore,
  switchWorkspaceLayoutWithFallback,
  detachWorkspaceLayout,
} from './state/layout-store';
import { WorkspaceBar } from './components/WorkspaceBar';
import { PaneGrid } from './components/PaneGrid';
import { CanvasView } from './components/CanvasView';
import { VoiceHud } from './components/VoiceHud';
import { VoiceSettings } from './components/VoiceSettings';
import { OrchestrationPanel } from './components/OrchestrationPanel';
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
import { OrchestrationModeDialog } from './components/OrchestrationModeDialog';
import { useConfirmStore } from './state/confirm-store';
import { useToastStore } from './state/toast-store';
import { missionBlockCauseText } from '../shared/mission-block-cause';
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
import {
  REAL_MISSION_E2E_PRODUCT_WIZARD_ACTIVE_STORAGE_KEY,
  REAL_MISSION_E2E_PRODUCT_WIZARD_READY_EVENT,
  REAL_MISSION_E2E_PRODUCT_WIZARD_READY_STORAGE_KEY,
  REAL_MISSION_E2E_SQUAD_ID,
} from '../shared/real-mission-e2e';
import { requestPaneClose } from './terminal/pane-close-guard';
import { NexusMark } from './components/NexusMark';
import { PixelIcon } from './components/PixelIcon';
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
  useOnboardingSync();
  useFailoverController();
  useAccountRestartController();

  useEffect(() => {
    const openPhysicalProductWizard = () => {
      if (
        window.sessionStorage.getItem(
          REAL_MISSION_E2E_PRODUCT_WIZARD_READY_STORAGE_KEY,
        ) !== '1'
      ) {
        return;
      }
      window.sessionStorage.removeItem(
        REAL_MISSION_E2E_PRODUCT_WIZARD_READY_STORAGE_KEY,
      );
      window.sessionStorage.setItem(
        REAL_MISSION_E2E_PRODUCT_WIZARD_ACTIVE_STORAGE_KEY,
        '1',
      );
      // Never let first-run onboarding cover the physical product-wizard gate.
      useOnboardingStore.getState().complete();
      useHomeStore.getState().hide();
      useMissionWizardStore
        .getState()
        .openForSquad(REAL_MISSION_E2E_SQUAD_ID);
    };
    window.addEventListener(
      REAL_MISSION_E2E_PRODUCT_WIZARD_READY_EVENT,
      openPhysicalProductWizard,
    );
    openPhysicalProductWizard();
    return () =>
      window.removeEventListener(
        REAL_MISSION_E2E_PRODUCT_WIZARD_READY_EVENT,
        openPhysicalProductWizard,
      );
  }, []);

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
    const isCurrentWorkspace = () =>
      useWorkspaceStore.getState().current?.path === path;
    void switchWorkspaceLayoutWithFallback(path, {
      isCurrent: isCurrentWorkspace,
    }).then(() => {
      if (!isCurrentWorkspace()) return;
      // Show the (non-modal) Home deck whenever what loaded is just a single
      // bare shell — a fresh folder AND a trivially-restored one look the same
      // to the user (an empty prompt), so both get the deck. A real mission
      // layout (agents, splits) restores the grid and continues main-owned
      // mission panes automatically (see restore-agents-gate).
      const panes = listPanes(useLayoutStore.getState().root);
      // Gate is also installed on layout restore; call again so App-path
      // restores that skipped the handler still pause agents.
      void gateRestoredAgents(panes);
      const loneBarShell =
        panes.length === 1 && panes[0].kind === 'shell' && !panes[0].orchRequestId;
      if (loneBarShell && !useMissionWizardStore.getState().open) {
        useHomeStore.getState().show();
      }
    }).catch((error) => {
      if (!isCurrentWorkspace()) return;
      console.error('[layout] workspace load failed after retry:', error);
      useHomeStore.getState().show();
      useToastStore.getState().push(
        'error',
        'Layout não pôde ser restaurado',
        'Abri um terminal seguro sem sobrescrever seu layout salvo. Reabra o workspace para tentar novamente.',
      );
    });
  }, [workspaceHydrated, currentWorkspace]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Confirm pendente = modal: nenhum atalho global dispara por baixo do
      // dialog (cinto extra além do capture-stop do próprio ConfirmDialog).
      if (useConfirmStore.getState().pending) return;
      // O wizard é modal: atalhos de workspace/panes não podem executar por
      // baixo dele enquanto a pessoa edita ou revisa a missão.
      if (useMissionWizardStore.getState().open) return;
      // Other hard dialogs (agent picker, update, etc.) own the keyboard while
      // mounted. Keep this generic so a future modal cannot accidentally let
      // workspace shortcuts mutate panes behind it.
      if (document.querySelector('[role="dialog"][aria-modal="true"]')) return;
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
      // ⌘N — nova missão guiada (objetivo primeiro, sem expor o seletor técnico).
      if (e.key.toLowerCase() === 'n' && !e.shiftKey && !e.altKey) {
        if (!useWorkspaceStore.getState().current) return;
        e.preventDefault();
        useMissionWizardStore.getState().openForAgentic();
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
          const isTechnicalFailure =
            event.kind === 'mission-technical-failure';
          const isWait = event.kind === 'agent-waiting';
          const isDone = event.kind === 'mission-done';
          if (!isBlock && !isTechnicalFailure && !isWait && !isDone) return;
          if (isDone) {
            useToastStore.getState().push(
              'success',
              'Missão concluída',
              `${event.title} — o resultado final foi validado.`,
            );
            return;
          }
          // A razão do bloqueio viaja no evento (main a lê da descrição
          // durável da missão). Sem ela o toast só dizia "travada aguardando
          // decisão" — nada que o operador pudesse entender ou resolver.
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
                  const orch = useOrchStore.getState();
                  if (event.missionId) {
                    // Direto ao diagnóstico da missão; o board cobriria o
                    // painel, então garante que ele está fechado.
                    if (orch.boardOpen) orch.closeBoard();
                    orch.openMissionDetail(event.missionId);
                    return;
                  }
                  if (!orch.boardOpen) orch.toggleBoard();
                  orch.openPanel('missions');
                },
              },
              dedupeKey: `mission-technical-failure:${event.title}`,
            });
            return;
          }
          const multi = /·|\d+\s+(missões|agentes)/i.test(event.title);
          const detail = multi
            ? `${event.title}. Abra o Ops Board ou o pet.`
            : isBlock
              ? `${event.title} — ${
                  why ??
                  'Motivo não registrado. Abra o diagnóstico da missão para ver o que aconteceu.'
                }`
              : `${event.title} — permissão/resposta pendente no terminal.`;
          useToastStore.getState().push(
            'warn',
            multi
              ? 'Várias coisas pedem você'
              : isBlock
                ? 'Missão precisa de você'
                : 'Agente pediu input',
            isBlock && !multi && event.missionId
              ? {
                  detail,
                  action: {
                    label: 'Abrir missão',
                    onClick: () => {
                      const orch = useOrchStore.getState();
                      if (orch.boardOpen) orch.closeBoard();
                      orch.openMissionDetail(event.missionId!);
                    },
                  },
                  dedupeKey: `mission-blocked:${event.missionId}`,
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
        <OrchestrationModeDialog />
        <Toasts />
      </div>
    );
  }

  // Workspace chosen but its layout still loading.
  if (!hydrated) {
    return <BootScreen />;
  }

  return (
    <div className="app">
      <WorkspaceBar
        onOpenDiff={() => setDiffOpen(true)}
        onOpenIntegrations={() => useIntegrationsStore.getState().show()}
        onOpenMediaStudio={() => useMediaStudioStore.getState().show()}
      />
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
        <MemoryPanel />
        <ConfigInventoryPanel />
        <ContextualPanel
          flagEnabled={productFlags[FEATURE_FLAG_IDS.contextualPanel] !== false}
          workspaceId={currentWorkspace?.path}
          initial={{ visible: false }}
          relevantTabs={[
            'mission',
            'editor',
            'git',
            'search',
            'skills',
            'marketplace',
            'browser',
            'memory',
          ]}
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
      <OrchestrationModeDialog />
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
