import { useEffect, useRef } from 'react';
import { useConfirmStore } from '../state/confirm-store';

/**
 * Dialog de confirmação da casa (reusa o idioma .confirm__* do fechar
 * workspace). MODAL de verdade, como o window.confirm que substituiu:
 * - keydown em fase de CAPTURA + stopImmediatePropagation — Esc não fecha o
 *   overlay de baixo (OpsBoard/Settings/Wizard) e atalhos globais (⌘K/⌘W)
 *   não vazam enquanto a pergunta está aberta;
 * - Tab preso nos controles (o focus-trap do SettingsDrawer não rouba);
 * - foco nasce no botão seguro (cancelar).
 */

export function ConfirmDialog() {
  const pending = useConfirmStore((s) => s.pending);
  const decide = useConfirmStore((s) => s.decide);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!pending) return undefined;
    cancelRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      // Nada atravessa o dialog: nem para os listeners de window dos
      // overlays de baixo, nem para os atalhos do App.
      e.stopImmediatePropagation();
      e.stopPropagation();
      if (e.key === 'Escape') {
        e.preventDefault();
        decide(false);
      } else if (e.key === 'Tab') {
        e.preventDefault();
        const focusables: HTMLElement[] = [];
        if (cancelRef.current) focusables.push(cancelRef.current);
        if (confirmRef.current) focusables.push(confirmRef.current);
        if (focusables.length === 0) return;
        const active = document.activeElement;
        const idx = focusables.findIndex((el) => el === active);
        const next = e.shiftKey
          ? focusables[(idx <= 0 ? focusables.length : idx) - 1]
          : focusables[(idx + 1) % focusables.length];
        next?.focus();
      } else if (e.key === 'Enter') {
        // Enter ativa o botão focado (comportamento nativo que o stop acima
        // não deve engolir).
        if (
          document.activeElement === cancelRef.current ||
          document.activeElement === confirmRef.current
        ) {
          e.preventDefault();
          decide(document.activeElement === confirmRef.current);
        }
      }
    };
    window.addEventListener('keydown', onKey, { capture: true });
    return () => window.removeEventListener('keydown', onKey, { capture: true });
  }, [pending, decide]);

  if (!pending) return null;

  return (
    <div
      className="confirm"
      role="alertdialog"
      aria-modal="true"
      aria-label={pending.title}
    >
      <div className="confirm__overlay" onClick={() => decide(false)} />
      <div className="confirm__panel">
        <h3 className="confirm__title">{pending.title}</h3>
        <p className="confirm__body">{pending.body}</p>
        <div className="confirm__actions">
          <button
            ref={cancelRef}
            type="button"
            className="confirm__btn"
            onClick={() => decide(false)}
          >
            {pending.cancelLabel ?? 'Cancelar'}
          </button>
          <button
            ref={confirmRef}
            type="button"
            className={`confirm__btn ${pending.danger ? 'confirm__btn--danger' : 'confirm__btn--primary'}`}
            onClick={() => decide(true)}
          >
            {pending.confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
