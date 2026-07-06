interface CloseButtonProps {
  onClick: () => void;
  label: string;
  className?: string;
  title?: string;
}

/** X nítido reutilizável — a mesma afordância de fechar em todo o app. */
export function CloseIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
      <path
        d="M2.5 2.5 L9.5 9.5 M9.5 2.5 L2.5 9.5"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function CloseButton({ onClick, label, className, title }: CloseButtonProps) {
  return (
    <button
      type="button"
      className={`icon-close ${className ?? ''}`}
      onClick={onClick}
      aria-label={label}
      title={title ?? label}
    >
      <CloseIcon />
    </button>
  );
}
