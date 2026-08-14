/**
 * Uma pergunta mid-run por missão, lida do ledger durável de handoffs.
 *
 * O snapshot de produção deixava `openQuestion` vazio: a UI do quadro
 * nunca via o clarify, então a pergunta sumia ao trocar de missão.
 * Isolamento é por missionId + sessão do orquestrador — não é quadro.
 */

import {
  parseClarifyAnswerArtifact,
  parseClarifyQuestionArtifact,
  type Clarify,
} from '../../shared/clarify';
import {
  missionQuestionSchema,
  type MissionQuestion,
} from '../../shared/mission-engine-contract';
import type { Handoff, Mission } from '../../shared/orch-types';

const OPERATOR_AGENT = 'Operador Nexus';

export type OpenQuestionMission = Pick<
  Mission,
  'id' | 'status' | 'intentState' | 'orchestratorSessionId'
>;

function isAnswerableMission(mission: OpenQuestionMission): boolean {
  // Só missão já parada à espera do operador. Clarify em `running` é
  // fire-and-forget no MCP: projetar openQuestion viraria o rail para
  // blocked_user e tiraria o Direct — atrito no caminho vivo.
  return (
    mission.status === 'blocked' && mission.intentState === 'blocked_user'
  );
}

function answeredQuestionIds(handoffs: readonly Handoff[]): Set<string> {
  const answered = new Set<string>();
  for (const handoff of handoffs) {
    if (
      handoff.sessionId !== undefined ||
      handoff.fromAgent !== OPERATOR_AGENT
    ) {
      continue;
    }
    for (const rawArtifact of handoff.artifacts) {
      const artifact = parseClarifyAnswerArtifact(rawArtifact);
      if (artifact) answered.add(artifact.questionId);
    }
  }
  return answered;
}

function toMissionQuestion(
  handoff: Handoff,
  clarify: Clarify,
): MissionQuestion | undefined {
  try {
    return missionQuestionSchema.parse({
      id: handoff.id,
      prompt: clarify.question,
      options: clarify.chips.map((chip) => ({
        id: chip.id,
        label: chip.label,
      })),
      allowFreeText: clarify.allowFreeform,
    });
  } catch {
    return undefined;
  }
}

/**
 * Primeira pergunta ainda sem resposta desta missão. Handoff de outra
 * missão, outra sessão, consumido ou já respondido não entra.
 */
export function resolveOpenMissionQuestion(
  mission: OpenQuestionMission,
  handoffs: readonly Handoff[],
): MissionQuestion | undefined {
  if (!isAnswerableMission(mission) || !mission.orchestratorSessionId) {
    return undefined;
  }
  const answered = answeredQuestionIds(handoffs);
  const candidates = handoffs
    .filter((handoff) => {
      if (handoff.missionId !== mission.id) return false;
      if (handoff.sessionId !== mission.orchestratorSessionId) return false;
      if (handoff.deliveryState === 'consumed') return false;
      if (answered.has(handoff.id)) return false;
      return true;
    })
    .sort((left, right) => {
      if (left.createdAt !== right.createdAt) {
        return left.createdAt - right.createdAt;
      }
      return left.id.localeCompare(right.id);
    });

  for (const handoff of candidates) {
    for (const rawArtifact of handoff.artifacts) {
      const artifact = parseClarifyQuestionArtifact(rawArtifact);
      if (!artifact) continue;
      const question = toMissionQuestion(handoff, artifact.clarify);
      if (question) return question;
    }
  }
  return undefined;
}
