import type { JarvisContext } from '../../shared/voice-ipc';
import { isMissionRuntimeSquadId } from '../../shared/orch-types';
import type { LayoutNode } from '../../shared/types';
import {
  isStructuralPlaceholderPane,
  listPanes,
} from '../lib/split-tree';
import { useLayoutStore } from '../state/layout-store';
import { useOrchStore } from '../state/orch-store';
import { useWorkspaceStore } from '../state/workspace-store';
import { buildScreenSnapshot, type ScreenSnapshot } from './screen-context';
import {
  listBlockingOverlayLabels,
  readUiVisibilityState,
} from './terminal-visibility';
import { useVoiceStore } from './voice-store';

export function personaUserName(): string {
  return useVoiceStore.getState().info?.persona.userName?.trim() ?? '';
}

export function findOrchestratorPane(root: LayoutNode): string | null {
  const panes = listPanes(root);
  const pane = panes.find(
    (candidate) =>
      candidate.orchRequestId?.startsWith('squad-') ||
      /(^|[ ·])orq\b/i.test(candidate.title),
  );
  return pane?.id ?? null;
}

export function currentScreenSnapshot(): ScreenSnapshot {
  const workspace = useWorkspaceStore.getState().current;
  const { root, focusedPaneId, viewKind } = useLayoutStore.getState();
  const panes = listPanes(root);
  const orchestratorPaneId = findOrchestratorPane(root);
  const orch = useOrchStore.getState();
  const ui = readUiVisibilityState();
  const blockingOverlays = listBlockingOverlayLabels(ui.overlays);
  const terminalVacant =
    ui.destination.kind === 'terminal' &&
    panes.length === 1 &&
    isStructuralPlaceholderPane(panes[0]!);

  return buildScreenSnapshot({
    workspaceName: workspace?.name ?? null,
    viewKind,
    panes,
    focusedPaneId,
    orchestratorPaneId,
    activeMissions: orch.missions
      .filter((mission) => mission.status !== 'done')
      .map((mission) => `${mission.title} (${mission.status})`),
    surface: {
      kind: 'product',
      destination: ui.destination,
      terminalVacant,
      blockingOverlays,
    },
  });
}

export function buildJarvisContext(): JarvisContext {
  const { root, focusedPaneId } = useLayoutStore.getState();
  const panes = listPanes(root);
  const orchestratorPaneId = findOrchestratorPane(root);
  const orchestratorPane =
    panes.find((pane) => pane.id === orchestratorPaneId) ?? null;
  const focusedPane =
    panes.find((pane) => pane.id === focusedPaneId) ?? null;
  const screen = currentScreenSnapshot();

  return {
    workspace: useWorkspaceStore.getState().current?.name ?? null,
    userName: personaUserName() || null,
    screen: screen.context,
    recents: useWorkspaceStore
      .getState()
      .recents.map((recent) => recent.name)
      .slice(0, 10),
    squads: useOrchStore
      .getState()
      .squads.filter((squad) => !isMissionRuntimeSquadId(squad.id))
      .map((squad) => squad.name),
    panes: panes
      .map((pane) => {
        const tag =
          pane.id === orchestratorPaneId
            ? '[orquestrador] '
            : pane.kind === 'shell'
              ? '[shell] '
              : pane.kind === 'browser'
                ? '[browser] '
                : '[agente] ';
        return `${tag}${pane.title}`;
      })
      .slice(0, 20),
    focusedPane: focusedPane?.title ?? null,
    focusedPaneKind: focusedPane?.kind ?? null,
    focusedPaneUrl: focusedPane?.browserUrl ?? null,
    orchestrator: orchestratorPane?.title ?? null,
    missions: useOrchStore
      .getState()
      .missions.filter((mission) => mission.status !== 'done')
      .map((mission) => `${mission.title} (${mission.status})`)
      .slice(0, 10),
  };
}
