// Adapted from pingdotgg/t3code @ 26285ab80513260d1ff29d2c3fbe18f21990cb62
// Copyright (c) 2026 T3 Tools Inc. — MIT License
// See third_party/licenses/t3code-MIT.txt. Nexus changes: só a guarda de IME do Enter (ComposerPromptEditorTiptap.tsx:975–977) levada a um textarea React via nativeEvent.isComposing/keyCode 229; o resto do composer é do Nexus.
import { useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import type {
  MissionAgentSnapshot,
  MissionEngineCommand,
  MissionSnapshot,
} from '../../../shared/mission-engine-contract';
import { toUserFacingMissionRecovery } from '../../lib/user-facing-mission-error';
import { appendQuote, quoteSpeaker, type QuoteDraft } from '../../lib/quote-reference';

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
  /**
   * WEB-17: citação vinda da atividade da missão. Entra no rascunho uma vez
   * por `nonce`, só desta missão e só fora de um envio em curso.
   */
  readonly quote?: QuoteDraft | null;
  readonly onQuoteConsumed?: (nonce: number) => void;
}

export function DirectionComposer({
  missionId,
  agents,
  disabled = false,
  onCommand,
  quote = null,
  onQuoteConsumed,
}: DirectionComposerProps) {
  const targetId = useId();
  const draftId = useId();
  const hintId = useId();
  const errorId = useId();
  const quoteNoticeId = useId();
  const pendingRef = useRef(false);
  const draftRef = useRef<HTMLTextAreaElement | null>(null);
  const [targetAgentId, setTargetAgentId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [quoteNotice, setQuoteNotice] = useState<string | null>(null);

  const consumedNonceRef = useRef<number | null>(null);
  const caretToEndRef = useRef(false);

  useEffect(() => {
    if (!quote || disabled || pending || quote.origin.missionId !== missionId) return;
    if (consumedNonceRef.current === quote.nonce) return;
    consumedNonceRef.current = quote.nonce;
    setDraft((current) => appendQuote(current, quote.text));
    setError(null);
    setQuoteNotice(
      `Citação de ${quoteSpeaker(quote.origin)} (evento #${quote.origin.sequence}) adicionada. A origem segue junto na orientação.`,
    );
    caretToEndRef.current = true;
    onQuoteConsumed?.(quote.nonce);
  }, [quote, disabled, pending, missionId, onQuoteConsumed]);

  // O texto citado só está no textarea depois do render: foco e cursor no
  // fim aqui, uma vez por citação — digitar depois não move o cursor.
  useEffect(() => {
    if (!caretToEndRef.current) return;
    caretToEndRef.current = false;
    const textarea = draftRef.current;
    if (!textarea) return;
    textarea.focus();
    const end = textarea.value.length;
    textarea.setSelectionRange?.(end, end);
  }, [draft]);

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
      setQuoteNotice(null);
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

  const describedBy = [hintId, quoteNotice ? quoteNoticeId : null, error ? errorId : null]
    .filter(Boolean)
    .join(' ');

  return (
    <form
      className="mission-board__direction-composer"
      aria-busy={pending}
      // Rascunho de várias linhas (citação, Shift+Enter): a barra deixa de ser pílula.
      data-multiline={draft.includes('\n') || undefined}
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
          ref={draftRef}
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
            if (!event.target.value.trim()) setQuoteNotice(null);
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

      {quoteNotice && (
        <p id={quoteNoticeId} className="mission-board__direction-quote" role="status">
          {quoteNotice}
        </p>
      )}

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
