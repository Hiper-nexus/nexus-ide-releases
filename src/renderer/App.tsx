import { useEffect, useRef } from 'react';
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
import { MissionRail } from './components/MissionRail';
import { SettingsDrawer } from './components/settings/SettingsDrawer';
import { LaunchScreen } from './components/LaunchScreen';
import { HomeDeck } from './components/HomeDeck';
import { MissionWizard } from './components/MissionWizard';
import {
  CloseWorkspaceDialog,
  useCloseWorkspaceStore,
} from './components/CloseWorkspaceDialog';
import { FilesPanel } from './components/FilesPanel';
import { useVoiceController } from './voice/voice-controller';
import { useOrchBridge } from './orch/orch-bridge';
import { useSettingsController, useSettingsStore } from './state/settings-store';
import { useWorkspaceController, useWorkspaceStore } from './state/workspace-store';
import { useProviderController } from './state/provider-store';
import { useMissionWizardStore } from './state/mission-wizard-store';
import { useHomeStore } from './state/home-store';
import { reconcileHosts, markResumeOnSpawn } from './terminal/terminal-host';
import {
  reconcileBrowserPanes,
  setBrowserPaneSuppression,
} from './browser/browser-host';
import { listPanes } from './lib/split-tree';
import { useFilesStore } from './state/files-store';
import { useAccountController } from './state/account-store';
import { useCostController } from './state/cost-store';
import { useUsageSync } from './state/usage-store';
import { useOnboardingStore, useOnboardingSync } from './state/onboarding-store';
import { Onboarding } from './components/Onboarding';
import { useFailoverController } from './orch/failover-controller';
import { Toasts } from './components/Toasts';
import { useVoiceStore } from './voice/voice-store';

/**
 * App root: hydrates the saved layout on boot and wires global keyboard
 * shortcuts (split/close) against the currently focused pane.
 */
export function App() {
  const hydrated = useLayoutStore((s) => s.hydrated);
  const viewKind = useLayoutStore((s) => s.viewKind);
  const workspaceHydrated = useWorkspaceStore((s) => s.hydrated);
  const currentWorkspace = useWorkspaceStore((s) => s.current);
  const settingsDrawerOpen = useSettingsStore((s) => s.drawerOpen);
  const missionWizardOpen = useMissionWizardStore((s) => s.open);
  const closeWorkspaceOpen = useCloseWorkspaceStore((s) => s.open);
  const voiceSettingsOpen = useVoiceStore((s) => s.settingsOpen);
  const onboardingVisible = useOnboardingStore(
    (s) => s.loaded && !s.state.completed && !s.state.skipped,
  );
  const suppressBrowserPanes =
    settingsDrawerOpen ||
    missionWizardOpen ||
    closeWorkspaceOpen ||
    voiceSettingsOpen ||
    onboardingVisible;

  useVoiceController();
  useOrchBridge();
  useSettingsController();
  useWorkspaceController();
  useProviderController();
  useAccountController();
  useCostController();
  useUsageSync();
  useOnboardingSync();
  useFailoverController();

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
      // layout (agents, splits) restores silently. If the "Novo workspace"
      // wizard is mid-flow it owns the launch; the deck would get in its way.
      const panes = listPanes(useLayoutStore.getState().root);
      // Retomada de sessão: panes de AGENTE restaurados voltam com --continue
      // (a mesma conversa de onde pararam), em vez de um agente zerado.
      for (const p of panes) {
        if (p.kind === 'cli-agent') markResumeOnSpawn(p.id);
      }
      const loneBarShell =
        panes.length === 1 && panes[0].kind === 'shell' && !panes[0].orchRequestId;
      if (loneBarShell && !useMissionWizardStore.getState().open) {
        useHomeStore.getState().show();
      }
    });
  }, [workspaceHydrated, currentWorkspace]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;
      // ⌘, — macOS-standard settings shortcut (works with no pane focused).
      if (e.key === ',') {
        e.preventDefault();
        useSettingsStore.getState().toggleDrawer();
        return;
      }
      const { focusedPaneId, split, close, viewKind: vk } = useLayoutStore.getState();
      if (!focusedPaneId) return;

      const key = e.key.toLowerCase();
      if (key === 'd' && vk === 'grid') {
        e.preventDefault();
        split(focusedPaneId, e.shiftKey ? 'column' : 'row');
      } else if (key === 'w') {
        e.preventDefault();
        close(focusedPaneId);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    setBrowserPaneSuppression('modal-overlay', suppressBrowserPanes);
  }, [suppressBrowserPanes]);

  useEffect(() => {
    return () => setBrowserPaneSuppression('modal-overlay', false);
  }, []);

  if (!workspaceHydrated) {
    return <div className="boot">Starting NexusIDE…</div>;
  }

  // No workspace open → onboarding launcher (first screen).
  // The wizard renders here too: "Novo workspace" starts from this screen.
  if (!currentWorkspace) {
    return (
      <div className="app">
        <LaunchScreen />
        <SettingsDrawer />
        <MissionWizard />
        <Toasts />
      </div>
    );
  }

  // Workspace chosen but its layout still loading.
  if (!hydrated) {
    return <div className="boot">Starting NexusIDE…</div>;
  }

  return (
    <div className="app">
      <WorkspaceBar />
      <main className="app__body">
        <MissionRail />
        <FilesPanel />
        {viewKind === 'canvas' ? <CanvasView /> : <PaneGrid />}
        <HomeDeck />
        <OrchestrationPanel />
      </main>
      <VoiceHud />
      <VoiceSettings />
      <SettingsDrawer />
      <MissionWizard />
      <CloseWorkspaceDialog />
      <Onboarding />
      <Toasts />
    </div>
  );
}
