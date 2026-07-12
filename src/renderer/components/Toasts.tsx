import { useToastStore } from '../state/toast-store';
import { PixelIcon } from './PixelIcon';

/** Stacked transient notifications, bottom-right. Severity reads from a small
 * status dot — not a side-tab accent border, which is a tell of AI-generated UI. */
export function Toasts() {
  const toasts = useToastStore((s) => s.toasts);
  const dismiss = useToastStore((s) => s.dismiss);
  if (toasts.length === 0) return null;
  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast toast--${t.kind}`}>
          <span className="toast__dot" aria-hidden="true" />
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
