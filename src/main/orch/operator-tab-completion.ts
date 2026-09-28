import type { Mission } from '../../shared/orch-types';
import { awaitingAdjustmentSince } from '../../shared/mission-recovery-policy';
import type { ProjectExecutionScope } from '../../shared/types';
import { missionLifecycleKey } from './mission-lifecycle-lock';

type CompletionMission = Pick<Mission, 'id' | 'description' | 'intentContract' | 'intentVersion' | 'orchestratorSessionId'>;
const requests = new Map<string, { intentVersion: number; requestedAt: number; sessionId?: string }>();

export const TAB_COMPLETION_INSTRUCTION =
  'Quando terminar todo o pedido do operador, inclusive a release se solicitada, ' +
  'chame nexus_mission_set_status({missionId, status:"done", note:"resumo da entrega e validação"}). ' +
  'A nota deve ter pelo menos 40 caracteres e descrever o que foi entregue e validado. ' +
  'Uma pausa ou entrega de helper não conclui esta missão.';

/** Scheduling intent only: the request never replaces review or completion proof. */
export function hasOperatorTabHost(mission: CompletionMission): boolean {
  return Boolean(mission.intentContract?.workspaceBinding?.adoptedPaneId);
}

/** F-185: helper deliveries and an idle composer do not finish the operator's request. */
export function awaitsOperatorTabCompletionRequest(scope: ProjectExecutionScope, mission: CompletionMission): boolean {
  if (!hasOperatorTabHost(mission)) return false;
  const request = requests.get(missionLifecycleKey(scope, mission.id));
  if (!request || request.intentVersion !== (mission.intentVersion ?? 0) ||
      request.sessionId !== mission.orchestratorSessionId) return true;
  const since = awaitingAdjustmentSince(mission.description ?? '');
  return since !== null && request.requestedAt <= since;
}

/**
 * Only the authorized done handler records intent. Description/handoff text is
 * never proof of a request. Restart/eviction fails closed: the resumed leader
 * requests done again after checking the delivery, through the same tool.
 */
export function recordOperatorTabCompletionRequest(scope: ProjectExecutionScope, mission: CompletionMission, now = Date.now()): void {
  const key = missionLifecycleKey(scope, mission.id);
  requests.delete(key);
  requests.set(key, { intentVersion: mission.intentVersion ?? 0, requestedAt: now, sessionId: mission.orchestratorSessionId });
  if (requests.size > 1024) requests.delete(requests.keys().next().value!);
}
