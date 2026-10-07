// Adapted from pingdotgg/t3code @ 26285ab80513260d1ff29d2c3fbe18f21990cb62
// Copyright (c) 2026 T3 Tools Inc. — MIT License
// See third_party/licenses/t3code-MIT.txt. Nexus changes: só a guarda de IME do Enter (ComposerPromptEditorTiptap.tsx:975–977) levada a um textarea React via nativeEvent.isComposing/keyCode 229; o resto do composer é do Nexus.
import { useId, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import type {
  MissionAgentSnapshot,
  MissionEngineCommand,
  MissionSnapshot,
} from '../../../shared/mission-engine-contract';
import { toUserFacingMissionRecovery } from '../../lib/user-facing-mission-error';

const ALL_AGENTS_VALUE = '';
const DELIVERY_ERROR_MESSAGE =
  'Não foi possível enviar a orientação. Tente novamente.';

interface DirectionComposerProps {
  readonly missionId: string;
  readonly agents: readonly MissionAgentSnapshot[];
  readonly disabled?: boolean;
  readonly onCommand: (
    command: MissionEngineCommand,
  ) => Promise<MissionSnapshot>;
}

export function DirectionComposer({
  missionId,
  agents,
  disabled = false,
  onCommand,
}: DirectionComposerProps) {
  const targetId = useId();
  const draftId = useId();
  const hintId = useId();
  const errorId = useId();
  const pendingRef = useRef(false);
  const [targetAgentId, setTargetAgentId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (disabled) return null;

  const submitDirection = async (): Promise<void> => {
    const text = draft.trim();
    if (!text || pendingRef.current) return;

    pendingRef.current = true;
    setPending(true);
    setError(null);

    try {
      await onCommand({
        kind: 'direct',
        missionId,
        targetAgentId,
        text,
      });
      setDraft('');
    } catch (reason) {
      setError(toUserFacingMissionRecovery(reason, DELIVERY_ERROR_MESSAGE));
    } finally {
      pendingRef.current = false;
      setPending(false);
    }
  };

  const handleSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    void submitDirection();
  };

  const handleDraftKeyDown = (
    event: KeyboardEvent<HTMLTextAreaElement>,
  ): void => {
    // Enter que confirma a composição do IME (acentos, pinyin, kana) não envia.
    if (
      event.key === 'Enter' &&
      (event.nativeEvent.isComposing || event.keyCode === 229)
    ) {
      event.stopPropagation();
      return;
    }
    if (event.key !== 'Enter' || event.shiftKey) return;
    event.preventDefault();
    void submitDirection();
  };

  const describedBy = error ? `${hintId} ${errorId}` : hintId;

  return (
    <form
      className="mission-board__direction-composer"
      aria-busy={pending}
      onSubmit={handleSubmit}
    >
      <div className="mission-board__direction-field mission-board__direction-field--target">
        <label htmlFor={targetId}>Enviar para</label>
        <select
          id={targetId}
          className="mission-board__direction-target"
          value={targetAgentId ?? ALL_AGENTS_VALUE}
          disabled={pending}
          onChange={(event) => {
            setTargetAgentId(event.target.value || null);
            setError(null);
          }}
        >
          <option value={ALL_AGENTS_VALUE}>@todos</option>
          {agents.map((agent) => (
            <option key={agent.id} value={agent.id}>
              {agent.agentName}
            </option>
          ))}
        </select>
      </div>

      <div className="mission-board__direction-field mission-board__direction-field--draft">
        <label htmlFor={draftId}>Orientação</label>
        <textarea
          id={draftId}
          className="mission-board__direction-draft"
          value={draft}
          placeholder="Escreva uma orientação para a equipe"
          disabled={pending}
          aria-invalid={Boolean(error)}
          aria-describedby={describedBy}
          onChange={(event) => {
            setDraft(event.target.value);
            setError(null);
          }}
          onKeyDown={handleDraftKeyDown}
        />
        <span id={hintId} className="mission-board__direction-hint">
          Enter envia. Shift+Enter adiciona uma nova linha.
        </span>
      </div>

      <button
        type="submit"
        className="mission-board__direction-submit"
        disabled={pending || !draft.trim()}
      >
        {pending ? 'Enviando orientação…' : 'Enviar orientação'}
      </button>

      {error && (
        <p
          id={errorId}
          className="mission-board__direction-error"
          role="alert"
          aria-atomic="true"
        >
          {error}
        </p>
      )}
    </form>
  );
}
