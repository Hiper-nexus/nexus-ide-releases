import type { PaneModel, ViewKind } from '../../shared/types';
import type { ProductDestination } from '../state/product-navigation-store';

export interface ScreenSnapshot {
  context: string;
  wakePrompt: string;
}
export type ScreenSurface =
  | {
      kind: 'product';
      destination: ProductDestination;
      terminalVacant: boolean;
      blockingOverlays: string[];
    }
  | { kind: 'voice-settings' }
  | { kind: 'operator-profile' }
  | { kind: 'settings' }
  | { kind: 'close-workspace' }
  | { kind: 'workspace'; blockingOverlays: string[] };

export interface BuildScreenSnapshotInput {
  workspaceName: string | null;
  viewKind: ViewKind;
  panes: PaneModel[];
  focusedPaneId: string | null;
  orchestratorPaneId: string | null;
  activeMissions: string[];
  surface: ScreenSurface;
}

const MAX_CONTEXT_CHARS = 900;
const MAX_PANES_IN_CONTEXT = 8;

function clampContext(text: string): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (clean.length <= MAX_CONTEXT_CHARS) return clean;
  return `${clean.slice(0, MAX_CONTEXT_CHARS - 3).trimEnd()}...`;
}

function paneKindLabel(pane: PaneModel, orchestratorPaneId: string | null): string {
  if (pane.id === orchestratorPaneId || pane.role === 'orchestrator') return 'orchestrator';
  if (pane.kind === 'shell') return 'terminal';
  if (pane.kind === 'browser') return 'browser';
  return pane.agentName ? `agent ${pane.agentName}` : 'agent';
}

function paneSummary(pane: PaneModel, orchestratorPaneId: string | null): string {
  const label = paneKindLabel(pane, orchestratorPaneId);
  const url = pane.kind === 'browser' && pane.browserUrl ? ` @ ${pane.browserUrl}` : '';
  return `[${label}; id=${pane.id}] ${pane.title}${url}`;
}

function focusedSummary(
  panes: PaneModel[],
  focusedPaneId: string | null,
  orchestratorPaneId: string | null,
): string {
  const pane = focusedPaneId ? panes.find((p) => p.id === focusedPaneId) : null;
  if (!pane) return 'none';
  return paneSummary(pane, orchestratorPaneId);
}

function focusedWakeLabel(
  panes: PaneModel[],
  focusedPaneId: string | null,
  orchestratorPaneId: string | null,
): string {
  const pane = focusedPaneId ? panes.find((p) => p.id === focusedPaneId) : null;
  if (!pane) return 'none';
  if (pane.id === orchestratorPaneId || pane.role === 'orchestrator') {
    return `orquestrador ${pane.title}`;
  }
  if (pane.kind === 'shell') return `terminal ${pane.title}`;
  if (pane.kind === 'browser') return `browser ${pane.title}`;
  return `agente ${pane.title}`;
}

function panesSummary(panes: PaneModel[], orchestratorPaneId: string | null): string {
  if (panes.length === 0) return 'none';
  const shown = panes
    .slice(0, MAX_PANES_IN_CONTEXT)
    .map((pane) => paneSummary(pane, orchestratorPaneId));
  const remaining = panes.length - shown.length;
  return remaining > 0 ? `${shown.join('; ')}; +${remaining} more` : shown.join('; ');
}

function productDestinationContext(
  destination: ProductDestination,
  terminalVacant: boolean,
): string {
  switch (destination.kind) {
    case 'launcher':
      return 'launcher';
    case 'terminal':
      return terminalVacant ? 'terminal vacancy (vaga livre)' : 'terminal';
    case 'project':
      return 'project overview (projeto / flock)';
    case 'mission-setup':
      return 'mission setup (preparar missão)';
    case 'mission':
      return destination.surface === 'terminals'
        ? `mission terminals ${destination.missionId}`
        : `mission board ${destination.missionId}`;
    case 'task-board':
      return 'task board (quadro de tarefas)';
    case 'memory':
      return 'memory (memória)';
    case 'settings':
      return `settings (configurações), seção ${destination.section}`;
  }
}

function surfaceContext(surface: ScreenSurface): string {
  switch (surface.kind) {
    case 'product': {
      const blocked =
        surface.blockingOverlays.length > 0
          ? `; blocking overlays: ${surface.blockingOverlays.join(', ')}`
          : '';
      return `${productDestinationContext(surface.destination, surface.terminalVacant)}${blocked}`;
    }
    case 'voice-settings':
      return 'voice settings open: pipeline, keys, wake word, live mode, persona';
    case 'operator-profile':
      return 'operator profile overlay open (covers workspace panes; terminal NOT visible)';
    case 'settings':
      return 'settings destination open: providers, accounts, catalog, media, shortcuts, modules';
    case 'close-workspace':
      return 'close-workspace confirmation dialog open (blocks workspace view)';
    case 'workspace': {
      const blocked =
        surface.blockingOverlays.length > 0
          ? `; blocking overlays: ${surface.blockingOverlays.join(', ')}`
          : '';
      return `workspace canvas/grid surface${blocked}`;
    }
  }
}

function wakePrompt(surface: ScreenSurface, focused: string, workspaceName: string): string {
  switch (surface.kind) {
    case 'product':
      switch (surface.destination.kind) {
        case 'launcher':
          return 'Estou no Launcher. Quer abrir um workspace ou iniciar uma missão?';
        case 'terminal':
          return surface.terminalVacant
            ? 'Estou no Terminal, em uma vaga livre. Quer abrir um terminal aqui?'
            : focused === 'none'
              ? `Estou no Terminal do workspace ${workspaceName}. Quer abrir uma nova sessão?`
              : `Estou no ${focused}. O que vamos fazer nele?`;
        case 'project':
          return `Estou no Projeto do workspace ${workspaceName}. Quer preparar uma missão ou focar uma sessão?`;
        case 'mission-setup':
          return 'Estou no Mission Setup. Quer continuar preparando a missão?';
        case 'mission':
          return surface.destination.surface === 'terminals'
            ? `Estou nos terminais da missão ${surface.destination.missionId}. Quer focar algum agente?`
            : `Estou no quadro da missão ${surface.destination.missionId}. O que quer verificar?`;
        case 'task-board':
          return 'Estou no Quadro de Tarefas. Quer abrir ou organizar uma tarefa?';
        case 'memory':
          return 'Estou na Memória. O que você quer recordar ou registrar?';
        case 'settings':
          return `Estou nas Configurações, seção ${surface.destination.section}. O que quer ajustar?`;
      }
    case 'voice-settings':
      return 'Estou nas configuracoes de voz. O que voce quer ajustar agora?';
    case 'operator-profile':
      return 'Estou no perfil de operador cobrindo a tela. Quer fechar e abrir terminal ou missao?';
    case 'settings':
      return 'Estou nas configuracoes. Quer ajustar providers, keys ou outro modulo?';
    case 'close-workspace':
      return 'Estou no dialogo de fechar workspace. Quer cancelar e continuar no projeto?';
    case 'workspace':
      return focused === 'none'
        ? `Estou no workspace ${workspaceName}. Quer abrir missao, terminal ou squad?`
        : `Estou no ${focused}. O que vamos fazer nele?`;
  }
}

export function buildScreenSnapshot(input: BuildScreenSnapshotInput): ScreenSnapshot {
  const workspaceName = input.workspaceName ?? 'none';
  const focused = focusedSummary(
    input.panes,
    input.focusedPaneId,
    input.orchestratorPaneId,
  );
  const focusedForWake = focusedWakeLabel(
    input.panes,
    input.focusedPaneId,
    input.orchestratorPaneId,
  );
  const orchestrator = input.orchestratorPaneId
    ? input.panes.find((pane) => pane.id === input.orchestratorPaneId)?.title ?? 'active'
    : 'none';
  const missions = input.activeMissions.length > 0
    ? input.activeMissions.slice(0, 4).join('; ')
    : 'none';
  const shellCount = input.panes.filter((pane) => pane.kind === 'shell').length;
  const parts = [
    `Current Nexus screen: ${surfaceContext(input.surface)}.`,
    `Workspace: ${workspaceName}.`,
    `View: ${input.viewKind}.`,
    `Panes (${input.panes.length}, ${shellCount} shell): ${panesSummary(input.panes, input.orchestratorPaneId)}.`,
    `Focused: ${focused}.`,
    `Active orchestrator: ${orchestrator}.`,
    `Active missions: ${missions}.`,
    'Jarvis does NOT see pixels — only this structured state. Do not claim a pane is visible unless surface and focus confirm it.',
  ];

  return {
    context: clampContext(parts.join(' ')),
    wakePrompt: wakePrompt(input.surface, focusedForWake, workspaceName),
  };
}
