// Adapted from pingdotgg/t3code @ 26285ab80513260d1ff29d2c3fbe18f21990cb62
// Copyright (c) 2026 T3 Tools Inc. — MIT License
// See third_party/licenses/t3code-MIT.txt. Nexus changes: o rascunho é o ComposerTiptapEditor (F-1170), que carrega a guarda de IME do Enter (ComposerPromptEditorTiptap.tsx:975–977); o resto do composer é do Nexus.
import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import type {
  MissionAgentSnapshot,
  MissionEngineCommand,
  MissionSnapshot,
} from '../../../shared/mission-engine-contract';
import { toUserFacingMissionRecovery } from '../../lib/user-facing-mission-error';
import { appendQuote, quoteSpeaker, type QuoteDraft } from '../../lib/quote-reference';
import {
  ComposerTiptapEditor,
  type ComposerTiptapEditorHandle,
} from '../ComposerTiptapEditor';

const ALL_AGENTS_VALUE = '';
const DELIVERY_ERROR_MESSAGE =
  'Não foi possível enviar a orientação. Tente novamente.';
const FORMAT_SHORTCUTS =
  typeof navigator !== 'undefined' && /Mac|iPhone|iPad/u.test(navigator.platform)
    ? '⌘B, ⌘I e ⌘E'
    : 'Ctrl+B, Ctrl+I e Ctrl+E';

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
  const labelId = useId();
  const hintId = useId();
  const errorId = useId();
  const quoteNoticeId = useId();
  const pendingRef = useRef(false);
  const formRef = useRef<HTMLFormElement | null>(null);
  // D4: o editor vira contenteditable=false durante o envio e o navegador derruba o foco no body.
  const refocusEditorRef = useRef(false);
  const draftRef = useRef<ComposerTiptapEditorHandle | null>(null);
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

  // O texto citado só está no editor depois do render (o efeito do filho
  // aplica o valor antes deste): foco e cursor no fim aqui, uma vez por
  // citação — digitar depois não move o cursor.
  useEffect(() => {
    if (!caretToEndRef.current) return;
    caretToEndRef.current = false;
    draftRef.current?.focusEnd();
  }, [draft]);

  // Terminado o envio (certo ou não), quem estava digitando volta ao editor; se a pessoa
  // levou o foco a outro campo no meio do envio, ele fica onde ela o pôs.
  useEffect(() => {
    if (pending || !refocusEditorRef.current) return;
    refocusEditorRef.current = false;
    const active = document.activeElement;
    if (!active || active === document.body || formRef.current?.contains(active)) {
      draftRef.current?.focus();
    }
  }, [pending]);

  if (disabled) return null;

  const submitDirection = async (): Promise<void> => {
    const text = draft.trim();
    if (!text || pendingRef.current) return;

    pendingRef.current = true;
    refocusEditorRef.current = formRef.current?.contains(document.activeElement) ?? false;
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

  const describedBy = [hintId, quoteNotice ? quoteNoticeId : null, error ? errorId : null]
    .filter(Boolean)
    .join(' ');

  return (
    <form
      ref={formRef}
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
        {/* A superfície é contenteditable: o nome vem por aria-labelledby;
            clicar no rótulo foca o editor como faria com o textarea. */}
        <label id={labelId} htmlFor={draftId} onClick={() => draftRef.current?.focus()}>
          Orientação
        </label>
        <ComposerTiptapEditor
          ref={draftRef}
          id={draftId}
          className="mission-board__direction-editor"
          surfaceClassName="mission-board__direction-draft"
          toolbar={false}
          value={draft}
          placeholder="Escreva uma orientação para a equipe"
          editable={!pending}
          ariaLabelledBy={labelId}
          ariaInvalid={Boolean(error)}
          ariaDescribedBy={describedBy}
          onSubmit={() => void submitDirection()}
          onChange={(markdown) => {
            setDraft(markdown);
            setError(null);
            if (!markdown.trim()) setQuoteNotice(null);
          }}
        />
        <span id={hintId} className="mission-board__direction-hint">
          Enter envia. Shift+Enter adiciona uma nova linha. {FORMAT_SHORTCUTS} formatam.
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
