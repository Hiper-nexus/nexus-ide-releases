import type { PaneModel, ViewKind } from '../../shared/types';

export interface ScreenSnapshot {
  context: string;
  wakePrompt: string;
}

export type ScreenSurface =
  | { kind: 'voice-settings' }
  | { kind: 'settings' }
  | { kind: 'wizard'; mode: string }
  | { kind: 'home'; readySquads: string[] }
  | { kind: 'files'; file: string | null; dirty: boolean }
  | { kind: 'ops-board'; missionCount: number }
  | { kind: 'orch-panel'; tab: string }
  | { kind: 'workspace' };

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
  return `[${label}] ${pane.title}${url}`;
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

function surfaceContext(surface: ScreenSurface, workspaceName: string): string {
  switch (surface.kind) {
    case 'voice-settings':
      return 'voice settings open: pipeline, keys, wake word, live mode, persona';
    case 'settings':
      return 'settings drawer open: providers, accounts, catalog, media, shortcuts, modules';
    case 'wizard':
      return `wizard open: ${surface.mode}`;
    case 'home': {
      const squads = surface.readySquads.length > 0
        ? `; ready squads: ${surface.readySquads.join(', ')}`
        : '';
      return `home deck open in workspace ${workspaceName}; visible actions: start mission, custom squad, terminal${squads}`;
    }
    case 'files':
      return surface.file
        ? `files panel open on ${surface.file}${surface.dirty ? ' with unsaved changes' : ''}`
        : 'files panel open with no selected file';
    case 'ops-board':
      return `ops board open with ${surface.missionCount} missions`;
    case 'orch-panel':
      return `orchestration panel open on ${surface.tab}`;
    case 'workspace':
      return 'workspace canvas/grid surface';
  }
}

function wakePrompt(surface: ScreenSurface, focused: string, workspaceName: string): string {
  switch (surface.kind) {
    case 'voice-settings':
      return 'Estou nas configuracoes de voz. O que voce quer ajustar agora?';
    case 'settings':
      return 'Estou nas configuracoes. Quer ajustar providers, keys ou outro modulo?';
    case 'wizard':
      return `Estou no assistente de ${surface.mode}. Qual opcao vamos escolher?`;
    case 'home':
      return 'Estou na tela Pronto para operar. Quer iniciar uma missao, montar um squad sob medida ou usar um squad pronto?';
    case 'files':
      return surface.file
        ? `Estou no arquivo ${surface.file}. Quer que eu leia, edite ou salve algo nele?`
        : 'Estou no painel de arquivos. Qual arquivo quer abrir?';
    case 'ops-board':
      return 'Estou no quadro de missoes. Quer ver status, abrir uma missao ou criar outra?';
    case 'orch-panel':
      return `Estou no painel de orquestracao, aba ${surface.tab}. O que quer verificar?`;
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
  const parts = [
    `Current Nexus screen: ${surfaceContext(input.surface, workspaceName)}.`,
    `Workspace: ${workspaceName}.`,
    `View: ${input.viewKind}.`,
    `Panes (${input.panes.length}): ${panesSummary(input.panes, input.orchestratorPaneId)}.`,
    `Focused: ${focused}.`,
    `Active orchestrator: ${orchestrator}.`,
    `Active missions: ${missions}.`,
  ];

  return {
    context: clampContext(parts.join(' ')),
    wakePrompt: wakePrompt(input.surface, focusedForWake, workspaceName),
  };
}
