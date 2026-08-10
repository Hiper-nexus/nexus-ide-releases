import type { PaneModel } from '../../shared/types';
import { listPanes } from './split-tree';
import { useLayoutStore } from '../state/layout-store';
import {
  useMissionInspectorStore,
  type InspectorTab,
} from '../state/mission-inspector-store';
import { useOrchStore } from '../state/orch-store';
import { useProductNavigationStore } from '../state/product-navigation-store';

export type MissionAttentionCause =
  | 'human-question'
  | 'human-input'
  | 'technical-failure'
  | 'technical-recovery'
  | 'rail-selection'
  | 'completed';

export type MissionAttentionRouteKey =
  | MissionAttentionCause
  | 'explicit-live-pane';

type MissionAttentionRoute =
  | { readonly surface: 'board'; readonly tab: InspectorTab }
  | { readonly surface: 'terminals'; readonly tab: null };

/**
 * The single cause-to-destination contract for mission attention. Terminals
 * exist only as the explicit-live-pane route selected after the pane id and
 * mission ownership are proven against the mounted layout.
 */
export const MISSION_ATTENTION_ROUTE_MATRIX = {
  'human-question': { surface: 'board', tab: 'chat' },
  'human-input': { surface: 'board', tab: 'chat' },
  'technical-failure': { surface: 'board', tab: 'activity' },
  'technical-recovery': { surface: 'board', tab: 'activity' },
  'rail-selection': { surface: 'board', tab: 'activity' },
  completed: { surface: 'board', tab: 'result' },
  'explicit-live-pane': { surface: 'terminals', tab: null },
} as const satisfies Readonly<
  Record<MissionAttentionRouteKey, MissionAttentionRoute>
>;

export interface RouteMissionAttentionInput {
  readonly missionId: string;
  readonly cause: MissionAttentionCause;
  readonly notificationPaneId?: string;
}

/** Resolve canonical mission ownership from layout metadata or orch binding. */
export function attentionMissionIdForPane(
  pane: PaneModel,
): string | undefined {
  return pane.missionId ?? useOrchStore.getState().paneMissions[pane.id];
}

export function routeMissionAttention({
  missionId,
  cause,
  notificationPaneId,
}: RouteMissionAttentionInput): void {
  const causeRoute = MISSION_ATTENTION_ROUTE_MATRIX[cause];
  useMissionInspectorStore
    .getState()
    .selectMissionTab(missionId, causeRoute.tab);

  const layout = useLayoutStore.getState();
  const notificationPane = notificationPaneId
    ? listPanes(layout.root).find(
        (pane) =>
          pane.id === notificationPaneId &&
          attentionMissionIdForPane(pane) === missionId,
      ) ?? null
    : null;
  const navigation = useProductNavigationStore.getState();
  const destinationRoute = notificationPane
    ? MISSION_ATTENTION_ROUTE_MATRIX['explicit-live-pane']
    : causeRoute;

  navigation.openMission(missionId);
  if (!notificationPane || destinationRoute.surface === 'board') return;

  navigation.showMissionTerminals();
  layout.focus(notificationPane.id);
}
