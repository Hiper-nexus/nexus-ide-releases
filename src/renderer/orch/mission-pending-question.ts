import {
  parseClarifyAnswerArtifact,
  parseClarifyQuestionArtifact,
  type DurableClarifyQuestion,
} from '../../shared/clarify';
import type { Handoff, Mission } from '../../shared/orch-types';

/**
 * Perguntas pendentes de verdade — extraído de MissionClarifyCards para que o
 * rail, os cards e a causa de bloqueio leiam a MESMA verdade.
 *
 * O que isto conserta: `missionBlockCause` sabe dizer "a missão está esperando
 * uma resposta sua", mas o ramo só dispara com `pendingQuestion: true` e
 * NENHUM chamador de produção passava esse campo — a cópia era código morto e
 * o rail mostrava "Motivo não registrado" para uma missão parada esperando o
 * operador. Nome errado é pior que silêncio: manda diagnosticar o que não
 * quebrou.
 *
 * Duas mudanças em relação ao filtro antigo dos cards:
 *  - `blocked` entra. Uma missão pode bloquear COM pergunta aberta; era
 *    exatamente o caso sem superfície nenhuma.
 *  - a lista de status vive aqui, não espalhada por componente.
 */

function isAnswerableMission(mission: Mission): boolean {
  if (mission.status === 'running') return true;
  // Worker-decision stop: chips are the human exit. Technical blocks are not.
  return (
    mission.status === 'blocked' && mission.intentState === 'blocked_user'
  );
}

/** Handoffs escritos pelo operador ao responder — nunca são perguntas. */
const OPERATOR_AGENT = 'Operador Nexus';

function answeredQuestionIds(handoffs: readonly Handoff[]): Set<string> {
  const answered = new Set<string>();
  for (const handoff of handoffs) {
    if (handoff.sessionId !== undefined || handoff.fromAgent !== OPERATOR_AGENT) {
      continue;
    }
    for (const rawArtifact of handoff.artifacts) {
      const artifact = parseClarifyAnswerArtifact(rawArtifact);
      if (artifact) answered.add(artifact.questionId);
    }
  }
  return answered;
}

/**
 * Perguntas duráveis ainda sem resposta, mais antigas primeiro, com o título
 * da missão junto — sem ele o card pergunta no vácuo quando há duas missões
 * ativas.
 */
export function pendingMissionQuestions(
  missions: readonly Mission[],
  handoffs: readonly Handoff[],
): Array<DurableClarifyQuestion & { readonly missionTitle: string }> {
  const answerable = new Map(
    missions
      .filter((mission) => isAnswerableMission(mission))
      .map((mission) => [mission.id, mission] as const),
  );
  const answered = answeredQuestionIds(handoffs);
  const questions: Array<
    DurableClarifyQuestion & { missionTitle: string; createdAt: number }
  > = [];
  for (const handoff of handoffs) {
    const mission = handoff.missionId
      ? answerable.get(handoff.missionId)
      : undefined;
    if (
      !mission ||
      !mission.orchestratorSessionId ||
      handoff.sessionId !== mission.orchestratorSessionId ||
      handoff.deliveryState === 'consumed' ||
      answered.has(handoff.id)
    ) {
      continue;
    }
    for (const rawArtifact of handoff.artifacts) {
      const artifact = parseClarifyQuestionArtifact(rawArtifact);
      if (!artifact) continue;
      questions.push({
        missionId: mission.id,
        missionTitle: mission.title,
        questionId: handoff.id,
        createdAt: handoff.createdAt,
        ...artifact.clarify,
      });
      break;
    }
  }
  return questions
    .sort((left, right) => left.createdAt - right.createdAt)
    .map(({ createdAt: _createdAt, ...question }) => question);
}

/** Ids das missões com ao menos uma pergunta aberta. */
export function missionIdsAwaitingAnswer(
  missions: readonly Mission[],
  handoffs: readonly Handoff[],
): Set<string> {
  return new Set(
    pendingMissionQuestions(missions, handoffs).map(
      (question) => question.missionId,
    ),
  );
}
