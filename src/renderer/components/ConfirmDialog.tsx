import { useEffect, useRef, useState } from 'react';
import { useConfirmStore } from '../state/confirm-store';

/**
 * Dialog de confirmação da casa (reusa o idioma .confirm__* do fechar
 * workspace). MODAL de verdade, como o window.confirm que substituiu:
 * - keydown em fase de CAPTURA + stopImmediatePropagation — Esc não fecha o
 *   overlay de baixo (OpsBoard/Settings/Wizard) e atalhos globais (⌘K/⌘W)
 *   não vazam enquanto a pergunta está aberta;
 * - Tab preso nos controles (o focus-trap do SettingsDrawer não rouba);
 * - foco nasce no botão seguro (cancelar), ou no textarea se reason for pedido.
 */

export function ConfirmDialog() {
  const pending = useConfirmStore((s) => s.pending);
  const decide = useConfirmStore((s) => s.decide);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const reasonRef = useRef<HTMLTextAreaElement>(null);
  const [reason, setReason] = useState('');

  useEffect(() => {
    if (!pending) return undefined;
    setReason('');
    const focusTarget = pending.requireReason
      ? reasonRef.current
      : cancelRef.current;
    focusTarget?.focus();
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
        if (pending.requireReason && reasonRef.current) {
          focusables.push(reasonRef.current);
        }
        if (cancelRef.current) focusables.push(cancelRef.current);
        if (confirmRef.current) focusables.push(confirmRef.current);
        if (focusables.length === 0) return;
        const active = document.activeElement;
        const idx = focusables.findIndex((el) => el === active);
        const next = e.shiftKey
          ? focusables[(idx <= 0 ? focusables.length : idx) - 1]
          : focusables[(idx + 1) % focusables.length];
        next?.focus();
      } else if (e.key === 'Enter' && !pending.requireReason) {
        // Enter ativa o botão focado (comportamento nativo que o stop acima
        // não deve engolir). With a reason field, Enter stays in the textarea.
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

  const minReason = pending.reasonMinLength ?? 8;
  const reasonOk =
    !pending.requireReason || reason.trim().length >= minReason;

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
        {pending.requireReason && (
          <label className="confirm__reason">
            <span className="confirm__reason-label">
              {pending.reasonLabel}
            </span>
            <textarea
              ref={reasonRef}
              className="confirm__reason-input"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder={pending.reasonPlaceholder ?? 'Descreva o motivo…'}
              rows={3}
              aria-required="true"
            />
            {reason.trim().length > 0 && !reasonOk && (
              <span className="confirm__reason-hint">
                Mínimo {minReason} caracteres.
              </span>
            )}
          </label>
        )}
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
            disabled={!reasonOk}
            onClick={() => decide(true, reason)}
          >
            {pending.confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
