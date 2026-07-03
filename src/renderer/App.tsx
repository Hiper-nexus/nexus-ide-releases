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
import { SettingsDrawer } from './components/settings/SettingsDrawer';
import { LaunchScreen } from './components/LaunchScreen';
import { MissionWizard } from './components/MissionWizard';
import { useVoiceController } from './voice/voice-controller';
import { useOrchBridge } from './orch/orch-bridge';
import { useSettingsController } from './state/settings-store';
import { useWorkspaceController, useWorkspaceStore } from './state/workspace-store';
import { useProviderController } from './state/provider-store';
import { useMissionWizardStore } from './state/mission-wizard-store';

/**
 * App root: hydrates the saved layout on boot and wires global keyboard
 * shortcuts (split/close) against the currently focused pane.
 */
export function App() {
  const hydrated = useLayoutStore((s) => s.hydrated);
  const viewKind = useLayoutStore((s) => s.viewKind);
  const workspaceHydrated = useWorkspaceStore((s) => s.hydrated);
  const currentWorkspace = useWorkspaceStore((s) => s.current);

  useVoiceController();
  useOrchBridge();
  useSettingsController();
  useWorkspaceController();
  useProviderController();

  // Each workspace owns its pane layout (Overclock parity): entering one
  // loads ITS saved tree; leaving to the launcher detaches. Entering a folder
  // WITHOUT saved panes asks Livre/Squad — a folder with a saved mission
  // restores silently, and a restart restoring the persisted workspace never
  // re-asks (the first hydrated value is the baseline).
  const lastWorkspacePath = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    if (!workspaceHydrated) return;
    const path = currentWorkspace?.path ?? null;
    if (!path) {
      detachWorkspaceLayout();
      lastWorkspacePath.current = path;
      return;
    }
    const isUserSwitch =
      lastWorkspacePath.current !== undefined &&
      path !== lastWorkspacePath.current;
    lastWorkspacePath.current = path;
    void switchWorkspaceLayout(path).then((hadSavedLayout) => {
      if (!isUserSwitch || hadSavedLayout) return;
      const wizard = useMissionWizardStore.getState();
      // The "Novo workspace" wizard opens the folder itself mid-flow; don't
      // stack a second wizard on top of it.
      if (!wizard.open) wizard.openForMission();
    });
  }, [workspaceHydrated, currentWorkspace]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;
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

  if (!workspaceHydrated) {
    return <div className="boot">Starting NexusIDE…</div>;
  }

  // No workspace open → onboarding launcher (first screen, Overclock parity).
  // The wizard renders here too: "Novo workspace" starts from this screen.
  if (!currentWorkspace) {
    return (
      <div className="app">
        <LaunchScreen />
        <SettingsDrawer />
        <MissionWizard />
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
        {viewKind === 'canvas' ? <CanvasView /> : <PaneGrid />}
        <OrchestrationPanel />
      </main>
      <VoiceHud />
      <VoiceSettings />
      <SettingsDrawer />
      <MissionWizard />
    </div>
  );
}
