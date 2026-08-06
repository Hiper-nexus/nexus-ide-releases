import { useRef, useState, type RefObject } from "react";
import { PixelIcon, type PixelIconName } from "./PixelIcon";

const INTENT_CHIPS = [
  "Corrigir um bug",
  "Criar uma feature",
  "Revisar o código",
] as const;

export interface MissionComposerProps {
  readonly inputDisabled: boolean;
  readonly submitDisabled: boolean;
  readonly submitLabel: string;
  readonly submitIcon: PixelIconName;
  readonly submitButtonRef?: RefObject<HTMLButtonElement | null>;
  /**
   * POR QUE o campo está desabilitado, em uma frase. Sem isto o leitor de tela
   * anunciava "Enter começa · Shift+Enter quebra a linha" num textarea que não
   * aceita nada — a razão real morava num heading fora do composer, sem
   * vínculo com o campo.
   */
  readonly disabledReason?: string;
  readonly onSubmit: (intent: string) => void;
  readonly onOpenTerminal: () => void;
}

/**
 * Goal-first mission entry. The input stays deliberately small: the wizard
 * owns planning and approval; this surface only captures the operator's next
 * intent and hands it over with explicit provenance.
 */
export function MissionComposer({
  inputDisabled,
  submitDisabled,
  submitLabel,
  submitIcon,
  submitButtonRef,
  disabledReason,
  onSubmit,
  onOpenTerminal,
}: MissionComposerProps) {
  const [intent, setIntent] = useState("");
  const inputRef = useRef<HTMLTextAreaElement>(null);

  function submit(): void {
    onSubmit(intent.trim());
  }

  function selectChip(value: string): void {
    setIntent(value);
    inputRef.current?.focus();
  }

  return (
    <div className="home-deck__composer">
      <label className="home-deck__composer-label" htmlFor="mission-intent">
        Objetivo da missão
      </label>
      <textarea
        ref={inputRef}
        id="mission-intent"
        className="home-deck__composer-input"
        value={intent}
        maxLength={8_000}
        rows={3}
        disabled={inputDisabled}
        placeholder="Descreva o resultado que você quer entregar…"
        aria-describedby="mission-intent-hint"
        onChange={(event) => setIntent(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            if (!inputDisabled && !submitDisabled) submit();
          }
        }}
      />
      <div className="home-deck__composer-chips" aria-label="Sugestões de objetivo">
        {INTENT_CHIPS.map((chip) => (
          <button
            key={chip}
            type="button"
            className="home-deck__intent-chip"
            disabled={inputDisabled}
            onClick={() => selectChip(chip)}
          >
            <span className="home-deck__intent-chip-dot" aria-hidden="true" />
            {chip}
          </button>
        ))}
      </div>
      <div className="home-deck__composer-footer">
        <span id="mission-intent-hint" className="home-deck__composer-hint">
          {inputDisabled && disabledReason
            ? disabledReason
            : "Enter começa · Shift+Enter quebra a linha"}
        </span>
        <button
          ref={submitButtonRef}
          type="button"
          className="home-deck__cta"
          onClick={submit}
          disabled={submitDisabled}
        >
          <PixelIcon name={submitIcon} />
          {submitLabel}
        </button>
      </div>
      <button
        type="button"
        className="home-deck__terminal home-deck__dismiss"
        onClick={onOpenTerminal}
      >
        <PixelIcon name="terminal" size={12} />
        Abrir terminal
      </button>
    </div>
  );
}
