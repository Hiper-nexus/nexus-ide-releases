import { useToastStore, type ToastKind } from '../state/toast-store';
import { PixelIcon, type PixelIconName } from './PixelIcon';

const TOAST_ICON: Record<ToastKind, PixelIconName> = {
  success: 'star',
  info: 'sparkle',
  warn: 'warn',
  error: 'close',
};

/** Stacked transient notifications below the app bar, away from wizard actions. */
export function Toasts() {
  const toasts = useToastStore((s) => s.toasts);
  const dismiss = useToastStore((s) => s.dismiss);
  if (toasts.length === 0) return null;
  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast toast--${t.kind}`}>
          <span className="toast__icon" aria-hidden="true">
            <PixelIcon name={TOAST_ICON[t.kind] ?? 'sparkle'} size={14} />
          </span>
          <div className="toast__body">
            <span className="toast__title">{t.title}</span>
            {t.detail && <span className="toast__detail">{t.detail}</span>}
          </div>
          <button
            className="toast__close"
            onClick={() => dismiss(t.id)}
            aria-label="Fechar"
          >
            <PixelIcon name="close" size={11} />
          </button>
        </div>
      ))}
    </div>
  );
}
