import { useToastStore, type ToastKind } from '../state/toast-store';
import { PixelIcon, type PixelIconName } from './PixelIcon';

const TOAST_ICON: Record<ToastKind, PixelIconName> = {
  success: 'star',
  info: 'sparkle',
  warn: 'warn',
  error: 'close',
};

/**
 * Bottom-right transient notifications. Their layer stays below every modal
 * dimmer, so a toast never covers or captures a wizard/approval interaction.
 */
export function Toasts() {
  const toasts = useToastStore((s) => s.toasts);
  const dismiss = useToastStore((s) => s.dismiss);
  if (toasts.length === 0) return null;
  return (
    <div className="toasts" role="region" aria-label="Notificações">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={`toast toast--${t.kind}`}
          role={t.kind === 'error' || t.kind === 'warn' ? 'alert' : 'status'}
          aria-live={
            t.kind === 'error' || t.kind === 'warn' ? 'assertive' : 'polite'
          }
        >
          <span className="toast__icon" aria-hidden="true">
            <PixelIcon name={TOAST_ICON[t.kind] ?? 'sparkle'} size={14} />
          </span>
          <div className="toast__body">
            <span className="toast__title">{t.title}</span>
            {t.detail && <span className="toast__detail">{t.detail}</span>}
            {t.action && (
              <button
                type="button"
                className="toast__action"
                onClick={(e) => {
                  e.currentTarget.disabled = true;
                  const run = t.action!.onClick();
                  dismiss(t.id);
                  void Promise.resolve(run).catch(() => {
                    // action surfaces its own error toast
                  });
                }}
              >
                {t.action.label}
              </button>
            )}
          </div>
          <button
            type="button"
            className="toast__close"
            onClick={() => dismiss(t.id)}
            aria-label={`Fechar aviso: ${t.title}`}
          >
            <PixelIcon name="close" size={11} />
          </button>
        </div>
      ))}
    </div>
  );
}
