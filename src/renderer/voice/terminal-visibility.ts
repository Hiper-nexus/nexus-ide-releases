import type { PaneModel, ViewKind } from '../../shared/types';
import { listPanes } from '../lib/split-tree';
import { useCloseWorkspaceStore } from '../components/CloseWorkspaceDialog';
import { useFilesStore } from '../state/files-store';
import { useGamificationStore } from '../state/gamification-store';
import { useHomeStore } from '../state/home-store';
import { useLayoutStore } from '../state/layout-store';
import { useMissionWizardStore } from '../state/mission-wizard-store';
import { useOnboardingStore } from '../state/onboarding-store';
import { useOrchStore } from '../state/orch-store';
import { useSettingsStore } from '../state/settings-store';
import { useVoiceStore } from './voice-store';
import { useWorkspaceStore } from '../state/workspace-store';
import { getPaneSessionId } from '../terminal/terminal-host';

/** Overlays modais que cobrem a área de panes — o usuário não vê o terminal atrás. */
export interface BlockingOverlayFlags {
  operatorProfile: boolean;
  homeDeck: boolean;
  settingsDrawer: boolean;
  voiceSettings: boolean;
  missionWizard: boolean;
  opsBoard: boolean;
  onboarding: boolean;
  closeWorkspaceDialog: boolean;
  orchPanel: boolean;
  filesPanel: boolean;
}

export interface UiVisibilityState {
  workspaceOpen: boolean;
  viewKind: ViewKind;
  focusedPaneId: string | null;
  focusedPaneKind: PaneModel['kind'] | null;
  shellPaneIds: string[];
  overlays: BlockingOverlayFlags;
}

export interface TerminalVisibilityResult {
  visible: boolean;
  reasons: string[];
}

export function listBlockingOverlayLabels(overlays: BlockingOverlayFlags): string[] {
  const labels: string[] = [];
  if (overlays.operatorProfile) labels.push('perfil operador');
  if (overlays.homeDeck) labels.push('home deck');
  if (overlays.settingsDrawer) labels.push('configurações');
  if (overlays.voiceSettings) labels.push('configurações de voz');
  if (overlays.missionWizard) labels.push('assistente de missão');
  if (overlays.opsBoard) labels.push('quadro de missões');
  if (overlays.onboarding) labels.push('onboarding');
  if (overlays.closeWorkspaceDialog) labels.push('fechar workspace');
  if (overlays.orchPanel) labels.push('painel de orquestração');
  if (overlays.filesPanel) labels.push('painel de arquivos');
  return labels;
}

export function readUiVisibilityState(): UiVisibilityState {
  const workspace = useWorkspaceStore.getState().current;
  const layout = useLayoutStore.getState();
  const panes = listPanes(layout.root);
  const focused =
    layout.focusedPaneId != null
      ? panes.find((pane) => pane.id === layout.focusedPaneId) ?? null
      : null;
  const onboarding = useOnboardingStore.getState();
  const onboardingVisible =
    onboarding.loaded &&
    !onboarding.state.completed &&
    !onboarding.state.skipped;

  return {
    workspaceOpen: Boolean(workspace),
    viewKind: layout.viewKind,
    focusedPaneId: layout.focusedPaneId,
    focusedPaneKind: focused?.kind ?? null,
    shellPaneIds: panes.filter((pane) => pane.kind === 'shell').map((pane) => pane.id),
    overlays: {
      operatorProfile: useGamificationStore.getState().profileOpen,
      homeDeck: useHomeStore.getState().visible,
      settingsDrawer: useSettingsStore.getState().drawerOpen,
      voiceSettings: useVoiceStore.getState().settingsOpen,
      missionWizard: useMissionWizardStore.getState().open,
      opsBoard: useOrchStore.getState().boardOpen,
      onboarding: onboardingVisible,
      closeWorkspaceDialog: useCloseWorkspaceStore.getState().open,
      orchPanel: useOrchStore.getState().panelOpen,
      filesPanel: useFilesStore.getState().open,
    },
  };
}

export function assessTerminalVisibility(
  paneId: string,
  state: UiVisibilityState,
  hasSession: boolean,
): TerminalVisibilityResult {
  const reasons: string[] = [];

  if (!state.workspaceOpen) reasons.push('sem workspace aberto');
  if (!hasSession) reasons.push('pty sem sessão');
  if (!state.shellPaneIds.includes(paneId)) reasons.push('pane shell ausente');
  if (state.viewKind !== 'grid') reasons.push(`view ${state.viewKind} (terminal fora da grade)`);
  if (state.focusedPaneId !== paneId) reasons.push('terminal sem foco');
  if (state.focusedPaneKind !== 'shell') reasons.push('foco não está no terminal');

  for (const label of listBlockingOverlayLabels(state.overlays)) {
    reasons.push(`overlay: ${label}`);
  }

  return { visible: reasons.length === 0, reasons };
}

/** Estado atual: o usuário vê um terminal focado na grade, sem overlays? */
export function isTerminalVisibleToUser(paneId: string): TerminalVisibilityResult {
  const state = readUiVisibilityState();
  const hasSession = Boolean(getPaneSessionId(paneId));
  return assessTerminalVisibility(paneId, state, hasSession);
}
