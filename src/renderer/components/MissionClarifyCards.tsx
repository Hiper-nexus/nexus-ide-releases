import { useMemo, useState } from 'react';
import {
  parseClarifyAnswerArtifact,
  parseClarifyQuestionArtifact,
  type DurableClarifyQuestion,
} from '../../shared/clarify';
import type { Handoff, Mission } from '../../shared/orch-types';

interface MissionClarifyCardsProps {
  readonly missions: readonly Mission[];
  readonly handoffs: readonly Handoff[];
}

function pendingQuestions(
  missions: readonly Mission[],
  handoffs: readonly Handoff[],
): DurableClarifyQuestion[] {
  const activeMissions = new Map(
    missions
      .filter(
        (mission) =>
          mission.status === 'pending' || mission.status === 'running',
      )
      .map((mission) => [mission.id, mission] as const),
  );
  const answeredQuestionIds = new Set<string>();
  for (const handoff of handoffs) {
    if (
      handoff.sessionId !== undefined ||
      handoff.fromAgent !== 'Operador Nexus'
    ) {
      continue;
    }
    for (const rawArtifact of handoff.artifacts) {
      const artifact = parseClarifyAnswerArtifact(rawArtifact);
      if (artifact) answeredQuestionIds.add(artifact.questionId);
    }
  }
  const questions: Array<DurableClarifyQuestion & { createdAt: number }> = [];
  for (const handoff of handoffs) {
    const mission = handoff.missionId
      ? activeMissions.get(handoff.missionId)
      : undefined;
    if (
      !mission ||
      !mission.orchestratorSessionId ||
      handoff.sessionId !== mission.orchestratorSessionId ||
      handoff.deliveryState === 'consumed' ||
      answeredQuestionIds.has(handoff.id)
    ) {
      continue;
    }
    for (const rawArtifact of handoff.artifacts) {
      const artifact = parseClarifyQuestionArtifact(rawArtifact);
      if (!artifact) continue;
      questions.push({
        missionId: mission.id,
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

/**
 * Project-scoped decision surface. It renders only questions found in the
 * already-scoped handoff mirror; answers cross the preload bridge and main
 * revalidates mission + question ids before any delivery.
 */
export function MissionClarifyCards({
  missions,
  handoffs,
}: MissionClarifyCardsProps) {
  const questions = useMemo(
    () => pendingQuestions(missions, handoffs),
    [missions, handoffs],
  );
  const [busyQuestionId, setBusyQuestionId] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<Record<string, string>>({});
  const [freeform, setFreeform] = useState<Record<string, string>>({});

  const submit = async (
    question: DurableClarifyQuestion,
    answer: string,
  ) => {
    if (busyQuestionId) return;
    setBusyQuestionId(question.questionId);
    setFeedback((state) => ({ ...state, [question.questionId]: '' }));
    try {
      const result = await window.nexus.orch.answerClarify({
        missionId: question.missionId,
        questionId: question.questionId,
        answer,
      });
      setFeedback((state) => ({
        ...state,
        [question.questionId]: result.cta,
      }));
    } catch {
      setFeedback((state) => ({
        ...state,
        [question.questionId]:
          'Não foi possível entregar a resposta. Reabra a missão e tente novamente.',
      }));
    } finally {
      setBusyQuestionId(null);
    }
  };

  if (questions.length === 0) return null;

  return (
    <section
      className="mission-clarify"
      aria-label="Decisões pendentes das missões"
    >
      {questions.map((question) => {
        const busy = busyQuestionId === question.questionId;
        const message = feedback[question.questionId];
        const freeformValue = freeform[question.questionId] ?? '';
        return (
          <article className="mission-clarify__card" key={question.questionId}>
            <p className="mission-clarify__eyebrow">Decisão necessária</p>
            <p className="mission-clarify__question">{question.question}</p>
            <p className="mission-clarify__cta">
              Escolha uma opção para a missão continuar.
            </p>
            <div
              className="mission-clarify__options"
              aria-label={`Opções para: ${question.question}`}
            >
              {question.chips.map((chip) => (
                <button
                  key={chip.id}
                  type="button"
                  className="mission-clarify__option"
                  disabled={busy}
                  onClick={() => void submit(question, chip.id)}
                >
                  {chip.label}
                </button>
              ))}
            </div>
            {question.allowFreeform ? (
              <form
                className="mission-clarify__freeform"
                onSubmit={(event) => {
                  event.preventDefault();
                  if (freeformValue.trim()) {
                    void submit(question, freeformValue);
                  }
                }}
              >
                <input
                  type="text"
                  maxLength={4_000}
                  value={freeformValue}
                  disabled={busy}
                  placeholder="Ou responda com suas palavras"
                  aria-label="Resposta livre"
                  onChange={(event) =>
                    setFreeform((state) => ({
                      ...state,
                      [question.questionId]: event.target.value,
                    }))
                  }
                />
                <button
                  type="submit"
                  disabled={busy || !freeformValue.trim()}
                >
                  Enviar
                </button>
              </form>
            ) : null}
            {message ? (
              <p
                className="mission-clarify__feedback"
                role="status"
                aria-live="polite"
              >
                {message}
              </p>
            ) : null}
          </article>
        );
      })}
    </section>
  );
}
