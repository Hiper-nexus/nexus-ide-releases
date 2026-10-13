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
 * F-1007: o Maestro corrente pediu done nesta versão da missão. O idle dele
 * reverifica a entrega (o pedido chega com ele ocupado e a resposta manda
 * encerrar o turno); sem isto, missão sem watcher da Via Rápida nunca concluía.
 */
export function hasCurrentCompletionRequest(scope: ProjectExecutionScope, mission: CompletionMission): boolean {
  const request = requests.get(missionLifecycleKey(scope, mission.id));
  return Boolean(request && request.intentVersion === (mission.intentVersion ?? 0) &&
    request.sessionId !== undefined && request.sessionId === mission.orchestratorSessionId);
}

/** F-1428: when the current leader's done request was recorded (null when there is none). */
export function completionRequestedAt(scope: ProjectExecutionScope, mission: CompletionMission): number | null {
  return hasCurrentCompletionRequest(scope, mission)
    ? requests.get(missionLifecycleKey(scope, mission.id))!.requestedAt : null;
}

/**
 * F-1428: the verifier answered this request with a refusal delivered to the
 * leader. Consume it so the leader's idle does not re-verify in a loop; the
 * leader asks done again after the correction (same tool, same authority).
 */
export function clearCompletionRequest(scope: ProjectExecutionScope, missionId: string): void {
  requests.delete(missionLifecycleKey(scope, missionId));
}

/**
 * Only the authorized done handler records intent (any automatic-completion
 * mission; the tab gate above reads it only for an adopted pane). Description/handoff text is
 * never proof of a request. Restart/eviction fails closed: the resumed leader
 * requests done again after checking the delivery, through the same tool.
 */
export function recordOperatorTabCompletionRequest(scope: ProjectExecutionScope, mission: CompletionMission, now = Date.now()): void {
  const key = missionLifecycleKey(scope, mission.id);
  requests.delete(key);
  requests.set(key, { intentVersion: mission.intentVersion ?? 0, requestedAt: now, sessionId: mission.orchestratorSessionId });
  if (requests.size > 1024) requests.delete(requests.keys().next().value!);
}
