import { useEffect, useRef } from 'react';
import { useChoiceStore, type ChoiceOption } from '../state/choice-store';

/**
 * Dialog de escolha da casa (idioma .confirm__* do ConfirmDialog): MODAL de
 * verdade — keydown em captura, Esc cancela, Tab preso nas opções, foco nasce
 * na primeira. Enter ativa a opção focada.
 */
export function ChoiceDialog() {
  const pending = useChoiceStore((s) => s.pending);
  const decide = useChoiceStore((s) => s.decide);
  const optionsRef = useRef<Array<HTMLButtonElement | null>>([]);

  useEffect(() => {
    if (!pending) return undefined;
    optionsRef.current[0]?.focus();
    const onKey = (e: KeyboardEvent) => {
      e.stopImmediatePropagation();
      e.stopPropagation();
      if (e.key === 'Escape') {
        e.preventDefault();
        decide(null);
      } else if (e.key === 'Tab') {
        e.preventDefault();
        const focusables = optionsRef.current.filter(
          (el): el is HTMLButtonElement => Boolean(el),
        );
        if (focusables.length === 0) return;
        const active = document.activeElement;
        const idx = focusables.findIndex((el) => el === active);
        const next = e.shiftKey
          ? focusables[(idx <= 0 ? focusables.length : idx) - 1]
          : focusables[(idx + 1) % focusables.length];
        next?.focus();
      }
    };
    window.addEventListener('keydown', onKey, { capture: true });
    return () => window.removeEventListener('keydown', onKey, { capture: true });
  }, [pending, decide]);

  if (!pending) return null;

  const render = (option: ChoiceOption, index: number) => (
    <button
      key={option.value}
      ref={(el) => {
        optionsRef.current[index] = el;
      }}
      type="button"
      className={`confirm__orch-choice${
        option.primary ? ' confirm__orch-choice--recommended' : ''
      }`}
      onClick={() => decide(option.value)}
    >
      <span className="confirm__orch-choice-label">{option.label}</span>
      {option.detail ? (
        <span className="confirm__orch-choice-hint">{option.detail}</span>
      ) : null}
    </button>
  );

  return (
    <div
      className="confirm"
      role="dialog"
      aria-modal="true"
      aria-label={pending.title}
    >
      <div className="confirm__overlay" onClick={() => decide(null)} />
      <div className="confirm__panel">
        <h3 className="confirm__title">{pending.title}</h3>
        {pending.body ? <p className="confirm__body">{pending.body}</p> : null}
        <div className="confirm__orch-choices">
          {pending.options.map(render)}
          <button
            type="button"
            className="confirm__btn"
            onClick={() => decide(null)}
          >
            {pending.cancelLabel ?? 'Cancelar'}
          </button>
        </div>
      </div>
    </div>
  );
}
