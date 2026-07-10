/**
 * Screen + Jarvis context builders (extracted from voice-controller for size).
 */
import { useLayoutStore } from '../state/layout-store';
import { useOnboardingStore } from '../state/onboarding-store';
import { useWorkspaceStore } from '../state/workspace-store';
import { useOrchStore } from '../state/orch-store';
import { useMissionWizardStore } from '../state/mission-wizard-store';
import { useHomeStore } from '../state/home-store';
import { useFilesStore } from '../state/files-store';
import { useSettingsStore } from '../state/settings-store';
import { useGamificationStore } from '../state/gamification-store';
import { useCloseWorkspaceStore } from '../components/CloseWorkspaceDialog';
import { listPanes } from '../lib/split-tree';
import { useVoiceStore } from './voice-store';
import { buildScreenSnapshot, type ScreenSnapshot } from './screen-context';
import { listBlockingOverlayLabels, readUiVisibilityState } from './terminal-visibility';
import type { JarvisContext } from '../../shared/voice-ipc';

export function personaUserName(): string {
  return useVoiceStore.getState().info?.persona.userName?.trim() ?? '';
}

export function findOrchestratorPane(
  root: ReturnType<typeof useLayoutStore.getState>['root'],
): string | null {
  const panes = listPanes(root);
  const pane = panes.find(
    (p) => p.orchRequestId?.startsWith('squad-') || /(^|[ ·])orq\b/i.test(p.title),
  );
  return pane?.id ?? null;
}

export function currentScreenSnapshot(): ScreenSnapshot {
  const workspace = useWorkspaceStore.getState().current;
  const { root, focusedPaneId, viewKind } = useLayoutStore.getState();
  const panes = listPanes(root);
  const orchPaneId = findOrchestratorPane(root);
  const orch = useOrchStore.getState();
  const wizard = useMissionWizardStore.getState();
  const files = useFilesStore.getState();
  const settings = useSettingsStore.getState();
  const homeVisible = useHomeStore.getState().visible;
  const voiceSettingsOpen = useVoiceStore.getState().settingsOpen;
  const operatorProfileOpen = useGamificationStore.getState().profileOpen;
  const closeWorkspaceOpen = useCloseWorkspaceStore.getState().open;
  const onboarding = useOnboardingStore.getState();
  const onboardingVisible =
    onboarding.loaded && !onboarding.state.completed && !onboarding.state.skipped;
  const hiddenShellCount = panes.filter((pane) => pane.kind === 'shell').length;
  const activeMissions = orch.missions
    .filter((m) => m.status !== 'done')
    .map((m) => `${m.title} (${m.status})`);
  const baseScreenInput = {
    workspaceName: workspace?.name ?? null,
    viewKind,
    panes,
    focusedPaneId,
    orchestratorPaneId: orchPaneId,
    activeMissions,
  };

  if (voiceSettingsOpen) {
    return buildScreenSnapshot({
      ...baseScreenInput,
      surface: { kind: 'voice-settings' },
    });
  }
  if (operatorProfileOpen) {
    return buildScreenSnapshot({
      ...baseScreenInput,
      surface: { kind: 'operator-profile' },
    });
  }
  if (onboardingVisible) {
    return buildScreenSnapshot({
      ...baseScreenInput,
      surface: { kind: 'onboarding' },
    });
  }
  if (closeWorkspaceOpen) {
    return buildScreenSnapshot({
      ...baseScreenInput,
      surface: { kind: 'close-workspace' },
    });
  }
  if (settings.drawerOpen) {
    return buildScreenSnapshot({
      ...baseScreenInput,
      surface: { kind: 'settings' },
    });
  }
  if (wizard.open) {
    const mode = wizard.presetSquadId
      ? 'revisão de squad pronto — diga sim / inicia para confirmar e disparar'
      : wizard.agenticLaunchNonce > 0
        ? `nova missão no modo agêntico${
            wizard.agenticIntent ? ` — objetivo: ${wizard.agenticIntent.slice(0, 240)}` : ''
          }`
      : wizard.variant === 'workspace'
        ? 'novo workspace'
        : 'nova missão';
    return buildScreenSnapshot({
      ...baseScreenInput,
      surface: { kind: 'wizard', mode },
    });
  }
  if (homeVisible) {
    return buildScreenSnapshot({
      ...baseScreenInput,
      surface: {
        kind: 'home',
        readySquads: orch.squads.slice(0, 3).map((s) => s.name),
        hiddenShellCount,
      },
    });
  }
  if (files.open) {
    return buildScreenSnapshot({
      ...baseScreenInput,
      surface: {
        kind: 'files',
        file: files.openFile?.relPath ?? null,
        dirty: files.openFile?.dirty ?? false,
      },
    });
  }
  if (orch.boardOpen) {
    return buildScreenSnapshot({
      ...baseScreenInput,
      surface: { kind: 'ops-board', missionCount: orch.missions.length },
    });
  }
  if (orch.panelOpen) {
    return buildScreenSnapshot({
      ...baseScreenInput,
      surface: { kind: 'orch-panel', tab: orch.panelTab },
    });
  }

  const ui = readUiVisibilityState();
  const blockingOverlays = listBlockingOverlayLabels(ui.overlays);

  return buildScreenSnapshot({
    ...baseScreenInput,
    surface: { kind: 'workspace', blockingOverlays },
  });
}

export function buildJarvisContext(): JarvisContext {
  const { root, focusedPaneId } = useLayoutStore.getState();
  const panes = listPanes(root);
  const orchPaneId = findOrchestratorPane(root);
  const orchPane = panes.find((p) => p.id === orchPaneId) ?? null;
  const focusedPane = panes.find((p) => p.id === focusedPaneId) ?? null;
  const screen = currentScreenSnapshot();
  return {
    workspace: useWorkspaceStore.getState().current?.name ?? null,
    userName: personaUserName() || null,
    screen: screen.context,
    recents: useWorkspaceStore.getState().recents.map((r) => r.name).slice(0, 10),
    squads: useOrchStore.getState().squads.map((s) => s.name),
    panes: panes
      .map((p) => {
        const tag =
          p.id === orchPaneId
            ? '[orquestrador] '
            : p.kind === 'shell'
              ? '[shell] '
              : p.kind === 'browser'
                ? '[browser] '
                : '[agente] ';
        return `${tag}${p.title}`;
      })
      .slice(0, 20),
    focusedPane: focusedPane?.title ?? null,
    focusedPaneKind: focusedPane?.kind ?? null,
    focusedPaneUrl: focusedPane?.browserUrl ?? null,
    orchestrator: orchPane?.title ?? null,
    missions: useOrchStore
      .getState()
      .missions.filter((m) => m.status !== 'done')
      .map((m) => `${m.title} (${m.status})`)
      .slice(0, 10),
  };
}
