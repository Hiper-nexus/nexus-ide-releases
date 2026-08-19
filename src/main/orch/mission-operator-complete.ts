import type { MissionEngine } from './mission-engine';
import type { ProjectDomainStoreSuite } from './project-domain-store-registry';
import type { Mission, MissionOperatorCompleteResult } from '../../shared/orch-types';

const OPERATOR_COMPLETE_SUMMARY = 'Concluída pelo operador.';
const OPERATOR_COMPLETE_LEARNINGS =
  'O operador marcou a missão como concluída. Histórico e receipts permanecem.';

function isUndispatchedDraft(mission: Mission): boolean {
  if (mission.orchestratorSessionId !== undefined) return false;
  if (mission.status !== 'pending') return false;
  return (
    mission.intentState === undefined ||
    mission.intentState === 'legacy' ||
    mission.intentState === 'awaiting_goal' ||
    mission.intentState === 'draft' ||
    mission.intentState === 'intent_compiling' ||
    mission.intentState === 'ready_to_start' ||
    mission.intentState === 'awaiting_approval'
  );
}

export interface OperatorCompletePorts {
  completeVerified: MissionEngine['completeVerified'];
}

/**
 * Archives a mission the operator already finished. Encerrar only parks the
 * runtime (`blocked_user` + runtime-closed). Done still requires MissionEngine
 * verified completion — this is that path, with an operator result instead of
 * a fabricated agent receipt.
 */
export function completeMissionByOperator(
  scope: Parameters<MissionEngine['completeVerified']>[0],
  suite: Pick<ProjectDomainStoreSuite, 'missions'>,
  missionId: string,
  ports: OperatorCompletePorts,
): MissionOperatorCompleteResult {
  const current = suite.missions.get(missionId);
  if (!current) {
    return { ok: false, error: 'Missão não encontrada.' };
  }
  if (current.status === 'done') {
    return { ok: true, mission: current };
  }
  if (current.status === 'failed') {
    return {
      ok: false,
      mission: current,
      error: 'Missão falhou. Remova ou retome; não dá para concluir uma falha.',
    };
  }
  if (isUndispatchedDraft(current)) {
    return {
      ok: false,
      mission: current,
      error: 'Rascunho ainda não despachado. Descarte em vez de concluir.',
    };
  }

  try {
    ports.completeVerified(scope, {
      missionId: current.id,
      expectedStatus: current.status,
      expectedIntentState: current.intentState ?? 'blocked_user',
      expectedUpdatedAt: current.updatedAt,
      expectedIntentVersion: current.intentVersion ?? 0,
      learnings: OPERATOR_COMPLETE_LEARNINGS,
      result: {
        outcome: 'success',
        summary: OPERATOR_COMPLETE_SUMMARY,
        evidenceIds: [],
        artifactRefs: [],
      },
      // A palavra do operador vence o gate de revisão — este caminho só é
      // alcançável pelo IPC do operador, nunca pelo Maestro/MCP.
      operatorOverride: true,
    });
  } catch (error) {
    return {
      ok: false,
      mission: suite.missions.get(missionId) ?? current,
      error:
        error instanceof Error
          ? error.message
          : 'O motor recusou a conclusão. Tente novamente.',
    };
  }

  const next = suite.missions.get(missionId);
  if (!next || next.status !== 'done') {
    return {
      ok: false,
      mission: next ?? current,
      error: 'O motor não persistiu a conclusão. Tente novamente.',
    };
  }
  return { ok: true, mission: next };
}
