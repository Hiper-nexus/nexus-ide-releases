import { useId, type Dispatch, type FormEvent, type SetStateAction } from 'react';
import type {
  MissionEngineCommand,
  MissionQuestion as MissionQuestionContract,
  MissionSnapshot,
} from '../../../shared/mission-engine-contract';
import { toUserFacingMissionRecovery } from '../../lib/user-facing-mission-error';
import { MarkdownWithMermaid } from '../MarkdownWithMermaid';

const ANSWER_ERROR_MESSAGE =
  'Não foi possível enviar a resposta. Tente novamente.';

export interface MissionQuestionState {
  readonly optionId: string | null;
  readonly text: string;
  readonly pending: boolean;
  readonly error: string | null;
}

const pendingQuestionStates = new WeakSet<MissionQuestionState>();

interface MissionQuestionProps {
  readonly missionId: string;
  readonly question: MissionQuestionContract;
  readonly state: MissionQuestionState;
  readonly onStateChange: Dispatch<SetStateAction<MissionQuestionState>>;
  readonly onCommand: (
    command: MissionEngineCommand,
  ) => Promise<MissionSnapshot>;
  readonly onDismiss?: () => Promise<void>;
}

export function MissionQuestion({
  missionId,
  question,
  state,
  onStateChange,
  onCommand,
  onDismiss,
}: MissionQuestionProps) {
  const promptId = useId();
  const detailId = useId();
  const freeTextId = useId();
  const errorId = useId();
  const answerText = state.text.trim();
  const hasAnswer = Boolean(state.optionId || answerText);
  const describedBy = [question.detail ? detailId : null, state.error ? errorId : null]
    .filter(Boolean)
    .join(' ') || undefined;

  const submitAnswer = async (): Promise<void> => {
    if (state.pending || pendingQuestionStates.has(state) || !hasAnswer) return;

    pendingQuestionStates.add(state);

    const command: MissionEngineCommand = state.optionId
      ? {
          kind: 'answer-question',
          missionId,
          questionId: question.id,
          optionId: state.optionId,
        }
      : {
          kind: 'answer-question',
          missionId,
          questionId: question.id,
          text: answerText,
        };

    onStateChange({ ...state, pending: true, error: null });

    try {
      await onCommand(command);
      onStateChange((current) => ({
        ...current,
        pending: false,
        error: null,
      }));
    } catch (reason) {
      const error = toUserFacingMissionRecovery(reason, ANSWER_ERROR_MESSAGE);
      onStateChange((current) => ({
        ...current,
        pending: false,
        error,
      }));
    } finally {
      pendingQuestionStates.delete(state);
    }
  };

  const dismissQuestion = async (): Promise<void> => {
    if (!onDismiss || state.pending || pendingQuestionStates.has(state)) return;
    pendingQuestionStates.add(state);
    onStateChange({ ...state, pending: true, error: null });
    try {
      await onDismiss();
      onStateChange((current) => ({
        ...current,
        pending: false,
        error: null,
      }));
    } catch (reason) {
      const error = toUserFacingMissionRecovery(reason, ANSWER_ERROR_MESSAGE);
      onStateChange((current) => ({
        ...current,
        pending: false,
        error,
      }));
    } finally {
      pendingQuestionStates.delete(state);
    }
  };

  const handleSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    void submitAnswer();
  };

  return (
    <form
      className="mission-board__question"
      aria-labelledby={promptId}
      aria-describedby={describedBy}
      aria-busy={state.pending}
      onSubmit={handleSubmit}
    >
      <h3 id={promptId} className="mission-board__question-prompt">
        {question.prompt}
      </h3>

      {question.detail && (
        <MarkdownWithMermaid
          id={detailId}
          className="mission-board__question-detail"
          source={question.detail}
        />
      )}

      {question.options.length > 0 && (
        <fieldset className="mission-board__question-options">
          <legend>Opções de resposta</legend>
          {question.options.map((option) => (
            <button
              key={option.id}
              type="button"
              className="mission-board__question-option"
              aria-pressed={state.optionId === option.id}
              disabled={state.pending}
              onClick={() => {
                if (state.pending) return;
                onStateChange({
                  optionId: option.id,
                  text: '',
                  pending: false,
                  error: null,
                });
              }}
            >
              <span className="mission-board__question-option-label">
                {option.label}
              </span>
              {option.description && (
                <span className="mission-board__question-option-description">
                  {option.description}
                </span>
              )}
            </button>
          ))}
        </fieldset>
      )}

      {question.allowFreeText && (
        <div className="mission-board__question-free-text">
          <label htmlFor={freeTextId}>Resposta livre</label>
          <textarea
            id={freeTextId}
            value={state.text}
            disabled={state.pending}
            aria-invalid={Boolean(state.error)}
            aria-describedby={state.error ? errorId : undefined}
            onChange={(event) => {
              if (state.pending) return;
              onStateChange({
                optionId: null,
                text: event.target.value,
                pending: false,
                error: null,
              });
            }}
          />
        </div>
      )}

      <button
        type="submit"
        className="mission-board__question-submit"
        disabled={state.pending || !hasAnswer}
      >
        {state.pending ? 'Enviando resposta…' : 'Responder'}
      </button>

      {onDismiss && (
        <button
          type="button"
          className="mission-board__button mission-board__button--secondary"
          disabled={state.pending}
          onClick={() => {
            void dismissQuestion();
          }}
        >
          Agora não
        </button>
      )}

      {state.error && (
        <p
          id={errorId}
          className="mission-board__question-error"
          role="alert"
          aria-atomic="true"
        >
          {state.error}
        </p>
      )}
    </form>
  );
}
