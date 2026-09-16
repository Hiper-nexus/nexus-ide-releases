import type { PaneModel } from '../../shared/types';
import { listPanes } from './split-tree';
import { useLayoutStore } from '../state/layout-store';
import {
  useMissionInspectorStore,
  type InspectorTab,
} from '../state/mission-inspector-store';
import { useOrchStore } from '../state/orch-store';
import { useProductNavigationStore } from '../state/product-navigation-store';
import { getActiveWorkspacePath } from '../state/active-workspace';

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

/**
 * Deriva a causa a partir do ESTADO real da missão.
 *
 * Sem isto, um item da lista de atenção ou uma seleção no rail caía sempre na
 * mesma aba: o produto dizia "preciso de você" e depositava a pessoa numa
 * tela onde a pergunta não estava — e conferir uma entrega abria o log de
 * eventos. `mission-stuck` cobre blocked_user, failed E recovering, então uma
 * causa fixa erra em dois dos três.
 */
export function attentionCauseForMissionState(
  state: string | undefined,
): MissionAttentionCause {
  switch (state) {
    case 'completed':
      return 'completed';
    case 'blocked_user':
      return 'human-question';
    case 'failed':
    case 'blocked_technical':
      return 'technical-failure';
    case 'recovering':
      return 'technical-recovery';
    default:
      return 'rail-selection';
  }
}

export interface RouteMissionAttentionInput {
  readonly missionId: string;
  readonly cause: MissionAttentionCause;
  readonly notificationPaneId?: string;
}

/** Resolve canonical mission ownership from layout metadata or orch binding. */
export function attentionMissionIdForPane(
  pane: PaneModel,
): string | undefined {
  // `paneMissions` is persisted state that can be briefly absent while an
  // older renderer snapshot is hydrating. A missing binding means unbound;
  // navigation must never make a normal shell/voice command crash.
  const paneMissions = useOrchStore.getState().paneMissions ?? {};
  return pane.missionId ?? paneMissions[pane.id];
}

export function routeMissionAttention({
  missionId,
  cause,
  notificationPaneId,
}: RouteMissionAttentionInput): void {
  const orch = useOrchStore.getState();
  if (
    orch.missionSummariesHydrated &&
    orch.boundWorkspacePath !== null &&
    orch.boundWorkspacePath === getActiveWorkspacePath() &&
    !orch.missionSummaries.some((mission) => mission.id === missionId)
  ) return;

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
