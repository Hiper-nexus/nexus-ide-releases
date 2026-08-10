import { useEffect, useId, useRef, useState } from 'react';
import {
  MISSION_INTENT_GOAL_MAX_CHARS,
  type MissionLane,
} from '../../../shared/mission-intent';
import { MISSION_PREPARE_TITLE_MAX_CHARS } from '../../../shared/mission-engine-contract';
import type { WorkspaceInfo } from '../../../shared/workspace-types';
import {
  normalizeProjectContextPath,
  type MissionSetupDraft,
} from '../../state/mission-setup-store';
import {
  MISSION_LANE_OPTIONS,
  missionLanePresentation,
} from './mission-lane-presentation';

interface MissionStepProps {
  workspace: WorkspaceInfo | null;
  draft: MissionSetupDraft;
  draftFieldsDisabled: boolean;
  suppressHeadingAutofocus: boolean;
  pickingWorkspace: boolean;
  workspaceActionError: string | null;
  onPickWorkspace(): void;
  onObjectiveChange(objective: string): void;
  onTitleChange(title: string): void;
  onContextPathsChange(paths: readonly string[]): void;
  onLaneChange(lane: MissionLane): void;
  onContinue(): void;
}

interface ContextPathRowProps {
  path: string;
  index: number;
  disabled: boolean;
  disabledReasonId: string;
  onCommit(path: string): void;
  onRemove(): void;
  onRemoveButtonRef(button: HTMLButtonElement | null): void;
}

interface ValidationError {
  message: string;
  sequence: number;
  shouldFocus: boolean;
}

interface PendingRemovalFocus {
  removedPath: string;
  nextPath: string | null;
  previousPath: string | null;
}


function ContextPathRow({
  path,
  index,
  disabled,
  disabledReasonId,
  onCommit,
  onRemove,
  onRemoveButtonRef,
}: ContextPathRowProps) {
  const [value, setValue] = useState(path);
  const [error, setError] = useState<ValidationError | null>(null);
  const inputId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const validationSequenceRef = useRef(0);

  useEffect(() => setValue(path), [path]);

  useEffect(() => {
    if (error?.shouldFocus) inputRef.current?.focus();
  }, [error]);

  const reportError = (message: string, shouldFocus: boolean): void => {
    validationSequenceRef.current += 1;
    setError({
      message,
      sequence: validationSequenceRef.current,
      shouldFocus,
    });
  };

  const commit = (shouldFocus: boolean): void => {
    if (disabled) return;
    const normalized = normalizeProjectContextPath(value);
    if (!normalized) {
      reportError(
        'Use um caminho dentro do projeto, como src/App.tsx.',
        shouldFocus,
      );
      return;
    }
    setValue(normalized);
    setError(null);
    onCommit(normalized);
  };

  const errorId = `${inputId}-error`;
  const describedBy =
    [
      error ? errorId : null,
      disabled ? disabledReasonId : null,
    ]
      .filter(Boolean)
      .join(' ') || undefined;

  return (
    <li className="mission-context-row">
      <div className="mission-setup__field mission-context-row__field">
        <label htmlFor={inputId}>Arquivo ou referência {index + 1}</label>
        <input
          id={inputId}
          ref={inputRef}
          type="text"
          value={value}
          disabled={disabled}
          aria-invalid={Boolean(error)}
          aria-describedby={describedBy}
          onChange={(event) => {
            if (disabled) return;
            setValue(event.target.value);
            setError(null);
          }}
          onBlur={() => commit(false)}
          onKeyDown={(event) => {
            if (event.key !== 'Enter') return;
            event.preventDefault();
            commit(true);
          }}
        />
        {error && (
          <span
            key={error.sequence}
            id={errorId}
            className="mission-setup__inline-error"
            role="alert"
            aria-atomic="true"
          >
            {error.message}
          </span>
        )}
      </div>
      <button
        ref={onRemoveButtonRef}
        type="button"
        className="mission-setup__button mission-setup__button--quiet"
        aria-label={`Remover ${path}`}
        aria-describedby={disabled ? disabledReasonId : undefined}
        onClick={onRemove}
        disabled={disabled}
      >
        Remover
      </button>
    </li>
  );
}

export function MissionStep({
  workspace,
  draft,
  draftFieldsDisabled,
  suppressHeadingAutofocus,
  pickingWorkspace,
  workspaceActionError,
  onPickWorkspace,
  onObjectiveChange,
  onTitleChange,
  onContextPathsChange,
  onLaneChange,
  onContinue,
}: MissionStepProps) {
  const headingRef = useRef<HTMLHeadingElement>(null);
  const workspaceErrorRef = useRef<HTMLParagraphElement>(null);
  const objectiveRef = useRef<HTMLTextAreaElement>(null);
  const newContextInputRef = useRef<HTMLInputElement>(null);
  const advancedRef = useRef<HTMLDetailsElement>(null);
  const removeButtonRefs = useRef(new Map<string, HTMLButtonElement>());
  const validationSequenceRef = useRef(0);
  const [workspaceError, setWorkspaceError] =
    useState<ValidationError | null>(null);
  const [objectiveError, setObjectiveError] =
    useState<ValidationError | null>(null);
  const [newContextPath, setNewContextPath] = useState('');
  const [contextError, setContextError] =
    useState<ValidationError | null>(null);
  const [pendingRemovalFocus, setPendingRemovalFocus] =
    useState<PendingRemovalFocus | null>(null);

  const draftEditingDisabled = draftFieldsDisabled || !workspace;
  const disabledReasonId = 'mission-draft-disabled-reason';
  const disabledReason = workspace
    ? 'Resolva o carregamento do rascunho antes de preencher os dados da missão.'
    : 'Escolha uma pasta de projeto para preencher os dados da missão.';
  const lanePresentation = missionLanePresentation(draft.advanced.lane);

  useEffect(() => {
    if (!suppressHeadingAutofocus) headingRef.current?.focus();
  }, [suppressHeadingAutofocus]);

  useEffect(() => {
    if (workspace) setWorkspaceError(null);
  }, [workspace]);

  useEffect(() => {
    if (workspaceError?.shouldFocus) workspaceErrorRef.current?.focus();
  }, [workspaceError]);

  useEffect(() => {
    if (objectiveError?.shouldFocus) objectiveRef.current?.focus();
  }, [objectiveError]);

  useEffect(() => {
    if (contextError?.shouldFocus) newContextInputRef.current?.focus();
  }, [contextError]);

  useEffect(() => {
    if (!draftEditingDisabled) return;
    setObjectiveError(null);
    setContextError(null);
    setNewContextPath('');
    setPendingRemovalFocus(null);
    if (advancedRef.current?.open) advancedRef.current.open = false;
  }, [draftEditingDisabled]);

  useEffect(() => {
    if (!pendingRemovalFocus) return;
    if (draft.contextPaths.includes(pendingRemovalFocus.removedPath)) {
      setPendingRemovalFocus(null);
      return;
    }

    const nextButton = pendingRemovalFocus.nextPath
      ? removeButtonRefs.current.get(pendingRemovalFocus.nextPath)
      : null;
    const previousButton = pendingRemovalFocus.previousPath
      ? removeButtonRefs.current.get(pendingRemovalFocus.previousPath)
      : null;
    (nextButton ?? previousButton ?? newContextInputRef.current)?.focus();
    setPendingRemovalFocus(null);
  }, [draft.contextPaths, pendingRemovalFocus]);

  const createValidationError = (
    message: string,
    shouldFocus = true,
  ): ValidationError => {
    validationSequenceRef.current += 1;
    return {
      message,
      sequence: validationSequenceRef.current,
      shouldFocus,
    };
  };

  const addContextPath = (): void => {
    if (draftEditingDisabled) return;
    const normalized = normalizeProjectContextPath(newContextPath);
    if (!normalized) {
      setContextError(
        createValidationError(
          'Use um caminho dentro do projeto, como src/App.tsx.',
        ),
      );
      return;
    }
    if (draft.contextPaths.includes(normalized)) {
      setContextError(
        createValidationError('Esse arquivo ou referência já está na lista.'),
      );
      return;
    }
    if (draft.contextPaths.length >= 64) {
      setContextError(
        createValidationError(
          'A missão aceita até 64 arquivos ou referências.',
        ),
      );
      return;
    }
    onContextPathsChange([...draft.contextPaths, normalized]);
    setNewContextPath('');
    setContextError(null);
  };

  const removeContextPath = (path: string, index: number): void => {
    if (draftEditingDisabled) return;
    setPendingRemovalFocus({
      removedPath: path,
      nextPath: draft.contextPaths[index + 1] ?? null,
      previousPath: draft.contextPaths[index - 1] ?? null,
    });
    onContextPathsChange(
      draft.contextPaths.filter((_, itemIndex) => itemIndex !== index),
    );
  };

  const continueToTeam = (): void => {
    if (draftEditingDisabled) {
      setWorkspaceError(createValidationError(disabledReason));
      return;
    }
    if (!draft.objective.trim()) {
      setObjectiveError(
        createValidationError('Descreva a entrega antes de continuar.'),
      );
      return;
    }
    setWorkspaceError(null);
    setObjectiveError(null);
    onContinue();
  };

  const objectiveDescribedBy = [
    'mission-objective-hint',
    objectiveError ? 'mission-objective-error' : null,
    draftEditingDisabled ? disabledReasonId : null,
  ]
    .filter(Boolean)
    .join(' ');
  const newContextDescribedBy = [
    'mission-new-context-hint',
    contextError ? 'mission-new-context-error' : null,
    draftEditingDisabled ? disabledReasonId : null,
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <section className="mission-setup__step" aria-labelledby="mission-step-title">
      <header className="mission-setup__step-header">
        <p className="mission-setup__step-kicker">Etapa 1 · Missão</p>
        <h1 id="mission-step-title" ref={headingRef} tabIndex={-1}>
          O que você quer entregar?
        </h1>
        <p>
          Descreva o resultado em linguagem comum. A equipe só lê e altera
          arquivos dentro da pasta escolhida.
        </p>
      </header>

      <div className="mission-setup__continuous-section">
        <div className="mission-setup__field mission-setup__workspace-field">
          <label htmlFor="mission-workspace-path">Pasta do projeto</label>
          <div className="mission-setup__workspace-control">
            <input
              id="mission-workspace-path"
              type="text"
              value={workspace?.path ?? 'Nenhuma pasta escolhida'}
              readOnly
              aria-invalid={Boolean(workspaceError || workspaceActionError)}
              aria-describedby={[
                'mission-workspace-error',
                draftEditingDisabled ? disabledReasonId : null,
              ]
                .filter(Boolean)
                .join(' ')}
            />
            <button
              type="button"
              className="mission-setup__button mission-setup__button--secondary"
              onClick={onPickWorkspace}
              disabled={pickingWorkspace}
              aria-describedby={
                draftEditingDisabled ? disabledReasonId : undefined
              }
            >
              {pickingWorkspace ? 'Escolhendo pasta…' : 'Escolher pasta'}
            </button>
          </div>
          <p
            key={
              workspaceError
                ? `workspace-error-${workspaceError.sequence}`
                : workspaceActionError
                  ? `workspace-action-error-${workspaceActionError}`
                  : 'workspace-error-empty'
            }
            id="mission-workspace-error"
            ref={workspaceErrorRef}
            className="mission-setup__inline-error mission-setup__focus-message"
            role={workspaceError || workspaceActionError ? 'alert' : undefined}
            aria-atomic="true"
            tabIndex={-1}
          >
            {workspaceError?.message ?? workspaceActionError ?? ' '}
          </p>
          {draftEditingDisabled && (
            <p id={disabledReasonId} className="mission-setup__hint">
              {disabledReason}
            </p>
          )}
        </div>

        <div className="mission-setup__field mission-setup__objective-field">
          <label htmlFor="mission-objective">
            O que você quer que a equipe entregue?
          </label>
          <textarea
            id="mission-objective"
            ref={objectiveRef}
            value={draft.objective}
            rows={8}
            maxLength={MISSION_INTENT_GOAL_MAX_CHARS}
            placeholder="Exemplo: refaça o fluxo de cadastro para ficar simples no celular e confirme que ele funciona do início ao fim."
            disabled={draftEditingDisabled}
            aria-invalid={Boolean(objectiveError)}
            aria-describedby={objectiveDescribedBy}
            onChange={(event) => {
              if (draftEditingDisabled) return;
              onObjectiveChange(event.target.value);
              if (event.target.value.trim()) setObjectiveError(null);
            }}
          />
          <span id="mission-objective-hint" className="mission-setup__hint">
            Escreva em linguagem comum. Inclua o que precisa mudar e como você
            saberá que ficou pronto.
          </span>
          {objectiveError && (
            <span
              key={objectiveError.sequence}
              id="mission-objective-error"
              className="mission-setup__inline-error"
              role="alert"
              aria-atomic="true"
            >
              {objectiveError.message}
            </span>
          )}
        </div>

        <div className="mission-setup__field">
          <label htmlFor="mission-title">Nome da missão (opcional)</label>
          <input
            id="mission-title"
            type="text"
            value={draft.title}
            maxLength={MISSION_PREPARE_TITLE_MAX_CHARS}
            placeholder="Exemplo: Cadastro no celular"
            disabled={draftEditingDisabled}
            aria-describedby={
              draftEditingDisabled ? disabledReasonId : undefined
            }
            onChange={(event) => {
              if (!draftEditingDisabled) onTitleChange(event.target.value);
            }}
          />
        </div>
      </div>

      <div className="mission-setup__continuous-section">
        <div className="mission-setup__section-heading">
          <div>
            <h2>Arquivos e referências</h2>
            <p>Opcional. Use caminhos relativos à pasta do projeto.</p>
          </div>
          <span>{draft.contextPaths.length}/64</span>
        </div>

        {draft.contextPaths.length > 0 && (
          <ul className="mission-context-list" aria-label="Contexto da missão">
            {draft.contextPaths.map((path, index) => (
              <ContextPathRow
                key={path}
                path={path}
                index={index}
                disabled={draftEditingDisabled}
                disabledReasonId={disabledReasonId}
                onCommit={(nextPath) =>
                  onContextPathsChange(
                    draft.contextPaths.map((item, itemIndex) =>
                      itemIndex === index ? nextPath : item,
                    ),
                  )
                }
                onRemove={() => removeContextPath(path, index)}
                onRemoveButtonRef={(button) => {
                  if (button) {
                    removeButtonRefs.current.set(path, button);
                  } else {
                    removeButtonRefs.current.delete(path);
                  }
                }}
              />
            ))}
          </ul>
        )}

        <div className="mission-setup__context-add">
          <div className="mission-setup__field">
            <label htmlFor="mission-new-context">Adicionar arquivo ou referência</label>
            <input
              id="mission-new-context"
              ref={newContextInputRef}
              type="text"
              value={newContextPath}
              placeholder="src/App.tsx ou docs/spec.md"
              disabled={draftEditingDisabled}
              aria-invalid={Boolean(contextError)}
              aria-describedby={newContextDescribedBy}
              onChange={(event) => {
                if (draftEditingDisabled) return;
                setNewContextPath(event.target.value);
                setContextError(null);
              }}
              onKeyDown={(event) => {
                if (event.key !== 'Enter') return;
                event.preventDefault();
                addContextPath();
              }}
            />
            <span id="mission-new-context-hint" className="mission-setup__hint">
              Caminhos absolutos e itens fora da pasta não são aceitos.
            </span>
            {contextError && (
              <span
                key={contextError.sequence}
                id="mission-new-context-error"
                className="mission-setup__inline-error"
                role="alert"
                aria-atomic="true"
              >
                {contextError.message}
              </span>
            )}
          </div>
          <button
            type="button"
            className="mission-setup__button mission-setup__button--secondary"
            onClick={addContextPath}
            disabled={draftEditingDisabled || !newContextPath.trim()}
            aria-describedby={
              draftEditingDisabled ? disabledReasonId : undefined
            }
          >
            Adicionar contexto
          </button>
        </div>
      </div>

      <details
        ref={advancedRef}
        className="mission-setup__disclosure mission-setup__continuous-section"
      >
        <summary
          aria-disabled={draftEditingDisabled || undefined}
          aria-describedby={
            draftEditingDisabled ? disabledReasonId : undefined
          }
          tabIndex={draftEditingDisabled ? -1 : undefined}
          onClick={(event) => {
            if (draftEditingDisabled) event.preventDefault();
          }}
          onKeyDown={(event) => {
            if (
              draftEditingDisabled &&
              (event.key === 'Enter' || event.key === ' ')
            ) {
              event.preventDefault();
            }
          }}
        >
          Avançado
        </summary>
        <div className="mission-setup__field">
          <label htmlFor="mission-lane">Tipo de trabalho</label>
          <select
            id="mission-lane"
            value={draft.advanced.lane}
            disabled={draftEditingDisabled}
            aria-describedby={[
              'mission-lane-hint',
              draftEditingDisabled ? disabledReasonId : null,
            ]
              .filter(Boolean)
              .join(' ')}
            onChange={(event) => {
              if (!draftEditingDisabled) {
                onLaneChange(event.target.value as MissionLane);
              }
            }}
          >
            {MISSION_LANE_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          <span id="mission-lane-hint" className="mission-setup__hint">
            {lanePresentation.guidance}
          </span>
        </div>
      </details>

      <footer className="mission-setup__step-actions mission-setup__step-actions--end">
        <button
          type="button"
          className="mission-setup__button mission-setup__button--primary"
          onClick={continueToTeam}
        >
          Continuar para equipe
        </button>
      </footer>
    </section>
  );
}
