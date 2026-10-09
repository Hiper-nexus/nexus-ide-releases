import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { PixelIcon, type PixelIconName } from './PixelIcon';

/**
 * Product-action card: large hit target, pixel icon badge, title + optional
 * subtitle. Shared by Providers, empties, Settings CTAs (pet-style pattern).
 */

export type ActionCardVariant = 'default' | 'primary' | 'danger' | 'ghost';

export interface ActionCardProps
  extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  icon?: PixelIconName;
  title: string;
  subtitle?: string;
  variant?: ActionCardVariant;
  /** Compact toolbar row (still ≥44px). */
  size?: 'md' | 'sm';
  /** Atalho visível (kbd). Não entra no nome acessível. */
  shortcut?: string;
}

export function ActionCard({
  icon,
  title,
  subtitle,
  variant = 'default',
  size = 'md',
  shortcut,
  className = '',
  type = 'button',
  ...rest
}: ActionCardProps) {
  return (
    <button
      type={type}
      className={[
        'action-card',
        `action-card--${variant}`,
        size === 'sm' ? 'action-card--sm' : '',
        className,
      ]
        .filter(Boolean)
        .join(' ')}
      {...rest}
    >
      {icon && (
        <span className="action-card__icon" aria-hidden>
          <PixelIcon name={icon} size={size === 'sm' ? 16 : 18} />
        </span>
      )}
      <span className="action-card__copy">
        <strong className="action-card__title">{title}</strong>
        {subtitle ? <small className="action-card__sub">{subtitle}</small> : null}
      </span>
      {shortcut ? (
        <kbd className="launcher-action__shortcut" aria-hidden="true">
          {shortcut}
        </kbd>
      ) : null}
    </button>
  );
}

export function EmptyState({
  icon = 'sparkle',
  title,
  body,
  action,
  className = '',
  role = 'status',
}: {
  icon?: PixelIconName;
  title: string;
  body?: ReactNode;
  action?: ReactNode;
  className?: string;
  role?: 'status' | 'alert';
}) {
  return (
    <div className={`empty-state ${className}`.trim()} role={role}>
      <span className="empty-state__icon" aria-hidden>
        <PixelIcon name={icon} size={22} />
      </span>
      <div className="empty-state__body">
        <p className="empty-state__title">{title}</p>
        {body ? <div className="empty-state__copy">{body}</div> : null}
        {action ? <div className="empty-state__action">{action}</div> : null}
      </div>
    </div>
  );
}
