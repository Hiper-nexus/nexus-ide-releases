/**
 * Uma pergunta mid-run por missão, lida do ledger durável de handoffs.
 *
 * O snapshot de produção deixava `openQuestion` vazio: a UI do quadro
 * nunca via o clarify, então a pergunta sumia ao trocar de missão.
 * Isolamento é por missionId + sessão do orquestrador — não é quadro.
 */

import {
  parseClarifyAnswerArtifact,
  parseClarifyDismissArtifact,
  parseClarifyQuestionArtifact,
  type Clarify,
} from '../../shared/clarify';
import {
  missionQuestionSchema,
  type MissionQuestion,
} from '../../shared/mission-engine-contract';
import { wasMissionRuntimeClosedByOperator } from '../../shared/mission-recovery-policy';
import type { Handoff, Mission } from '../../shared/orch-types';

const OPERATOR_AGENT = 'Operador Nexus';

export type OpenQuestionMission = Pick<
  Mission,
  'id' | 'status' | 'intentState'
> & {
  readonly description?: string;
};

function isAnswerableMission(mission: OpenQuestionMission): boolean {
  // Só missão já parada à espera do operador. Clarify em `running` é
  // fire-and-forget no MCP: projetar openQuestion viraria o rail para
  // blocked_user e tiraria o Direct — atrito no caminho vivo.
  // Encerrar (runtime-closed) tem precedência: senão o rail mente
  // "Aguardando sua resposta" sobre uma missão que o operador fechou.
  if (wasMissionRuntimeClosedByOperator(mission)) return false;
  return (
    mission.status === 'blocked' && mission.intentState === 'blocked_user'
  );
}

function answeredQuestionIds(handoffs: readonly Handoff[]): Set<string> {
  const answered = new Set<string>();
  for (const handoff of handoffs) {
    for (const rawArtifact of handoff.artifacts) {
      const dismissed = parseClarifyDismissArtifact(rawArtifact);
      if (dismissed) {
        answered.add(dismissed.questionId);
        continue;
      }
      if (
        handoff.sessionId !== undefined ||
        handoff.fromAgent !== OPERATOR_AGENT
      ) {
        continue;
      }
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
 * missão, consumido ou já respondido não entra.
 *
 * Camadas de preferência (rodada 2 R3): pergunta da SESSÃO CORRENTE do
 * orquestrador ganha; sem nenhuma, a mais recente de sessão ANTERIOR fica
 * visível — a missão blocked_user está esperando resposta REAL não importa
 * qual encarnação perguntou, e sumir do rail era a trava da família
 * "elicitation não respondida" (rebind pós-respawn/restart).
 *
 * `currentOrchestratorSessionId` é o par resolvido por `resolveMissionLeader`
 * no chamador (main-owned) — nunca `mission.orchestratorSessionId` cru, que
 * pode divergir do claim físico/de pane em split-brain.
 */
export function resolveOpenMissionQuestion(
  mission: OpenQuestionMission,
  handoffs: readonly Handoff[],
  currentOrchestratorSessionId?: string | null,
): MissionQuestion | undefined {
  if (!isAnswerableMission(mission) || !currentOrchestratorSessionId) {
    return undefined;
  }
  const answered = answeredQuestionIds(handoffs);
  const candidates = handoffs
    .filter((handoff) => {
      if (handoff.missionId !== mission.id) return false;
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

  const questionOf = (handoff: Handoff): MissionQuestion | undefined => {
    for (const rawArtifact of handoff.artifacts) {
      const artifact = parseClarifyQuestionArtifact(rawArtifact);
      if (!artifact) continue;
      const question = toMissionQuestion(handoff, artifact.clarify);
      if (question) return question;
    }
    return undefined;
  };

  // 1ª camada: sessão corrente (ordem cronológica — a primeira em aberto).
  for (const handoff of candidates) {
    if (handoff.sessionId !== currentOrchestratorSessionId) continue;
    const question = questionOf(handoff);
    if (question) return question;
  }
  // 2ª camada: sessão anterior, a MAIS RECENTE (a vigente da época).
  for (let i = candidates.length - 1; i >= 0; i -= 1) {
    const question = questionOf(candidates[i]!);
    if (question) return question;
  }
  return undefined;
}

/**
 * Alguma pergunta durable desta missão ainda sem resposta/dismiss.
 *
 * Ao contrário de `resolveOpenMissionQuestion`, não filtra por status nem por
 * sessão: o operador continua sendo a peça que falta mesmo em `running`
 * (clarify é fire-and-forget no MCP) e depois de um rebind de sessão — é
 * esse silêncio que o vigia de momentum precisa para não empurrar o Maestro.
 */
export function hasOpenClarifyQuestion(
  missionId: string,
  handoffs: readonly Handoff[],
): boolean {
  const answered = answeredQuestionIds(handoffs);
  return handoffs.some((handoff) => {
    if (handoff.missionId !== missionId) return false;
    if (handoff.deliveryState === 'consumed') return false;
    if (answered.has(handoff.id)) return false;
    return handoff.artifacts.some(
      (raw) => parseClarifyQuestionArtifact(raw) !== null,
    );
  });
}
