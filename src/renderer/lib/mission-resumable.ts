import type { Mission } from '../../shared/orch-types';
import { wasMissionLeftoverParked } from '../../shared/mission-leftover-isolation';
import { wasMissionRuntimeClosedByOperator } from '../../shared/mission-recovery-policy';

/**
 * A missão aceita "Retomar missão" (reabrir a composição gravada)? `running` sempre;
 * `blocked` só quando não espera resposta do humano — ou quando o operador
 * encerrou o runtime / a missão ficou estacionada. Espera de resposta continua
 * sendo "Responder", nunca "Retomar". Fonte única da toolbar do pane e do ⌘K.
 */
export function missionIsResumable(mission: Mission): boolean {
  if (mission.status === 'running') return true;
  return (
    mission.status === 'blocked' &&
    (mission.intentState !== 'blocked_user' ||
      wasMissionRuntimeClosedByOperator(mission) ||
      wasMissionLeftoverParked(mission))
  );
}
