import { useToastStore } from '../state/toast-store';

const CloseIcon = () => (
  <svg width="11" height="11" viewBox="0 0 12 12" aria-hidden="true">
    <path
      d="M2.5 2.5 L9.5 9.5 M9.5 2.5 L2.5 9.5"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
    />
  </svg>
);

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
            <CloseIcon />
          </button>
        </div>
      ))}
    </div>
  );
}
