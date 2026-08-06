import { useMemo, useState } from 'react';
import type { DurableClarifyQuestion } from '../../shared/clarify';
import type { Handoff, Mission } from '../../shared/orch-types';
import { pendingMissionQuestions } from '../orch/mission-pending-question';

interface MissionClarifyCardsProps {
  readonly missions: readonly Mission[];
  readonly handoffs: readonly Handoff[];
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
    () => pendingMissionQuestions(missions, handoffs),
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
            {/* De QUAL missão. Com duas missões ativas o card perguntava no
                vácuo e o operador respondia às cegas. */}
            <p className="mission-clarify__eyebrow">
              Decisão necessária ·{' '}
              <span className="mission-clarify__mission" title={question.missionTitle}>
                {question.missionTitle}
              </span>
            </p>
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
                  const answer = freeformValue.trim();
                  if (answer) {
                    void submit(question, answer);
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
