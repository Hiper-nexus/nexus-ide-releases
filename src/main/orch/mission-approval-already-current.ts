/**
 * "Esta missão já está aprovada e rodando?" — a única pergunta que decide se o
 * approve precisa de uma NOVA decisão do operador (fix do re-prompt infinito,
 * 05/08).
 *
 * `approveIntentFromRenderer` já tinha a lane idempotente: quando a missão está
 * em `dispatched`/`executing` com autoridade de dispatch vigente e o mesmo
 * runtime de orquestrador, ele NÃO reaprova nada — só continua o bootstrap
 * main-owned (renderer-mission-authority.ts:1423-1441). Só que essa lane roda
 * DEPOIS do diálogo nativo (orch-ipc.ts: confirmMissionAuthorityChange vem
 * antes do approve), então cada re-clique reabria o modal de aprovação de uma
 * missão que a própria autoridade considera aprovada — com a missão viva em
 * fundo. O operador via "Aprovar esta missão e liberar sua execução?" para
 * sempre (voo real 05/08).
 *
 * Regra: aprovação é consumida pela máquina de estado. Enquanto o veredito
 * abaixo for verdadeiro, o approve não pode conceder autoridade nova (ele cai
 * na lane de continuar), logo perguntar é ruído — e ruído que trava o usuário.
 * Qualquer mudança MATERIAL (revisão de intent nova, aprovação revogada,
 * runtime do orquestrador diferente, missão fora de execução) derruba o
 * veredito e o modal nativo volta, intacto.
 */

import {
  hasCurrentApprovedDispatchContract,
  type InferIntentMission,
  type MissionOrchestratorRuntimeSnapshot,
} from "../../shared/mission-intent";
import { sameMissionOrchestratorGrantRuntime } from "./mission-orchestrator-runtime";

type ApprovalStateMission = InferIntentMission & {
  readonly intentVersion?: number | null;
};

/**
 * Alargado em 06/08 pelo voo real da 0.26.1 (missão d9dd6f27): duas janelas
 * cegas reabriam o modal de uma missão já aprovada e viva —
 * 1. TEMPORAL: approvedAt gravado segundos antes de o preflight promover a
 *    missão (status ainda 'pending' / intentState 'ready_to_start');
 * 2. DRIFT VOLÁTIL: accountId/effort são recomputados a cada tentativa
 *    (rotação de conta, tuning) e a igualdade estrita nunca mais batia com o
 *    contrato selado — modal para sempre, sem mudança material de autoridade.
 * Mudança MATERIAL continua derrubando o veredito: revisão de intent nova,
 * aprovação revogada, adapter/modelo/confinamento diferente, missão
 * bloqueada/encerrada ou aguardando decisão real do operador.
 */
export function missionApprovalAlreadyCurrent(
  mission: ApprovalStateMission,
  candidateRuntime: MissionOrchestratorRuntimeSnapshot,
): boolean {
  const from = mission.intentState ?? "ready_to_start";
  if (
    from !== "dispatched" &&
    from !== "executing" &&
    from !== "ready_to_start"
  ) {
    return false;
  }
  if (mission.status !== "running" && mission.status !== "pending") {
    return false;
  }
  if (!hasCurrentApprovedDispatchContract(mission)) return false;
  return sameMissionOrchestratorGrantRuntime(
    mission.intentContract?.orchestratorRuntime,
    candidateRuntime,
  );
}
