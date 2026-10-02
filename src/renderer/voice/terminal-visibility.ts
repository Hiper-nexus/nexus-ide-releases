import type { PaneModel } from '../../shared/types';
import { useCloseWorkspaceStore } from '../components/CloseWorkspaceDialog';
import { listPanes } from '../lib/split-tree';
import { useBugReportDialogStore } from '../state/bug-report-dialog-store';
import { useCheatsheetStore } from '../state/cheatsheet-store';
import { useCommandPaletteStore } from '../state/command-palette-store';
import { useConfirmStore } from '../state/confirm-store';
import { useGamificationStore } from '../state/gamification-store';
import { useLayoutStore } from '../state/layout-store';
import { useMediaStudioStore } from '../state/media-studio-store';
import { useOrchestrationModeStore } from '../state/orchestration-mode-store';
import {
  useProductNavigationStore,
  type ProductDestination,
} from '../state/product-navigation-store';
import { getPaneSessionId } from '../terminal/terminal-host';
import { useWorkspaceStore } from '../state/workspace-store';
import { useVoiceStore } from './voice-store';

/** Overlays modais que cobrem a área de panes — o usuário não vê o terminal atrás. */
export interface BlockingOverlayFlags {
  operatorProfile: boolean;
  voiceSettings: boolean;
  closeWorkspaceDialog: boolean;
  orchestrationMode: boolean;
  mediaStudio: boolean;
  commandPalette: boolean;
  confirmation: boolean;
  keyboardCheatsheet: boolean;
  bugReport: boolean;
}

export interface UiVisibilityState {
  workspaceOpen: boolean;
  destination: ProductDestination;
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
  if (overlays.voiceSettings) labels.push('configurações de voz');
  if (overlays.closeWorkspaceDialog) labels.push('fechar workspace');
  if (overlays.orchestrationMode) labels.push('modo de orquestração');
  if (overlays.mediaStudio) labels.push('estúdio de mídia');
  if (overlays.commandPalette) labels.push('paleta de comandos');
  if (overlays.confirmation) labels.push('confirmação');
  if (overlays.keyboardCheatsheet) labels.push('atalhos de teclado');
  if (overlays.bugReport) labels.push('reportar um problema');
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

  return {
    workspaceOpen: Boolean(workspace),
    destination: useProductNavigationStore.getState().destination,
    focusedPaneId: layout.focusedPaneId,
    focusedPaneKind: focused?.kind ?? null,
    shellPaneIds: panes
      .filter((pane) => pane.kind !== 'browser')
      .map((pane) => pane.id),
    overlays: {
      operatorProfile: useGamificationStore.getState().profileOpen,
      voiceSettings: useVoiceStore.getState().settingsOpen,
      closeWorkspaceDialog: useCloseWorkspaceStore.getState().open,
      orchestrationMode:
        useOrchestrationModeStore.getState().pending !== null,
      mediaStudio: useMediaStudioStore.getState().open,
      commandPalette: useCommandPaletteStore.getState().open,
      confirmation: useConfirmStore.getState().pending !== null,
      keyboardCheatsheet: useCheatsheetStore.getState().open,
      bugReport: useBugReportDialogStore.getState().isOpen,
    },
  };
}

export function assessTerminalVisibility(
  paneId: string,
  state: UiVisibilityState,
  hasSession: boolean,
): TerminalVisibilityResult {
  const reasons: string[] = [];

  const terminalDestination =
    state.destination.kind === 'terminal' ||
    (state.destination.kind === 'mission' &&
      state.destination.surface === 'terminals');
  if (!terminalDestination) {
    const surface =
      state.destination.kind === 'mission'
        ? `${state.destination.kind}/${state.destination.surface}`
        : state.destination.kind;
    reasons.push(`destino ${surface} não exibe uma superfície de terminal`);
  }
  if (!state.workspaceOpen) reasons.push('sem workspace aberto');
  if (!hasSession) reasons.push('pty sem sessão');
  if (!state.shellPaneIds.includes(paneId)) reasons.push('pane shell ausente');
  if (state.focusedPaneId !== paneId) reasons.push('terminal sem foco');
  if (state.focusedPaneKind === null || state.focusedPaneKind === 'browser') {
    reasons.push('foco não está em um terminal');
  }

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
