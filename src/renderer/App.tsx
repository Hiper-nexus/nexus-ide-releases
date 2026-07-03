import { useEffect, useRef } from 'react';
import { useLayoutStore } from './state/layout-store';
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
  const hydrate = useLayoutStore((s) => s.hydrate);
  const viewKind = useLayoutStore((s) => s.viewKind);
  const workspaceHydrated = useWorkspaceStore((s) => s.hydrated);
  const currentWorkspace = useWorkspaceStore((s) => s.current);

  useVoiceController();
  useOrchBridge();
  useSettingsController();
  useWorkspaceController();
  useProviderController();

  // Entering a folder asks Livre/Squad (Overclock parity). Only on a change
  // the user made in this session — a restart restoring the saved workspace
  // must NOT re-ask, so the first hydrated value is treated as baseline.
  const lastWorkspacePath = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    if (!workspaceHydrated) return;
    const path = currentWorkspace?.path ?? null;
    if (lastWorkspacePath.current === undefined) {
      lastWorkspacePath.current = path; // baseline from persisted state
      return;
    }
    if (path && path !== lastWorkspacePath.current) {
      const wizard = useMissionWizardStore.getState();
      // The "Novo workspace" wizard opens the folder itself mid-flow; don't
      // stack a second wizard on top of it.
      if (!wizard.open) wizard.openForMission();
    }
    lastWorkspacePath.current = path;
  }, [workspaceHydrated, currentWorkspace]);

  useEffect(() => {
    let cancelled = false;
    void window.nexus.layout.load().then((layout) => {
      if (!cancelled) hydrate(layout);
    });
    return () => {
      cancelled = true;
    };
  }, [hydrate]);

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

  if (!hydrated || !workspaceHydrated) {
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
