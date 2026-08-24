import type { MissionLifecycleState } from '../../shared/mission-engine-contract';
import { isolationStopLabel } from '../../shared/session-restore-liveness';

/**
 * Status words a civilian understands at a glance.
 * Keep these aligned across rail chips, board header, and related surfaces.
 * Never surface engine tokens (executing, intent_state, kickoff).
 *
 * blocked_user is a real operator ask ("Precisa de você"). Leftover
 * isolation / Encerrar persist the same intent_state but are Dormindo/Parou.
 */
export const MISSION_LIFECYCLE_LABELS: Readonly<
  Record<MissionLifecycleState, string>
> = {
  draft: 'Preparando',
  review_ready: 'Pronta para iniciar',
  starting: 'Iniciando',
  running: 'Trabalhando',
  blocked_user: 'Precisa de você',
  blocked_technical: 'Precisa de reparo',
  recovering: 'Recuperando',
  stopping: 'Parando',
  failed: 'Falhou',
  completed: 'Pronto',
};

/**
 * Concluída pelo motor, ainda não aprovada por quem pediu. "Pronto" ali dizia
 * que a missão acabou — e ela não acabou: falta a sua revisão.
 */
export const MISSION_AWAITING_REVIEW_LABEL = 'Aguardando você';

/** Running mission that still needs a human look — rail chip only. */
export const MISSION_RUNNING_ATTENTION_LABEL = 'Trabalhando · aviso';

export function missionLifecycleLabel(
  state: MissionLifecycleState,
  needsAttention = false,
  stateReasonCode?: string,
  awaitsOperatorReview = false,
): string {
  // Motor concluído ≠ humano aprovou. "Pronto" no header dos Terminais
  // lia como missão fechada — e o orquestrador sumia em seguida (F-108).
  if (state === 'completed' && awaitsOperatorReview) {
    return MISSION_AWAITING_REVIEW_LABEL;
  }
  // Persist done/failed is authority. session-dead leftover on the reason
  // must never paint Parou over Pronto.
  if (state === 'completed' || state === 'failed') {
    return MISSION_LIFECYCLE_LABELS[state];
  }
  const isolation = isolationStopLabel(stateReasonCode);
  if (isolation) return isolation;
  if (state === 'running' && needsAttention) {
    return MISSION_RUNNING_ATTENTION_LABEL;
  }
  return MISSION_LIFECYCLE_LABELS[state];
}
