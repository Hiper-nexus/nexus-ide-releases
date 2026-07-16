import { useEffect, useMemo, useRef, useState } from 'react';
import {
  agentNotificationStatusLabel,
  countUnread,
  formatNotificationAgo,
  type AgentNotification,
  type AgentNotificationKind,
} from '../../shared/agent-notification';
import { listPanes } from '../lib/split-tree';
import { useAgentNotificationStore } from '../state/agent-notification-store';
import { useLayoutStore } from '../state/layout-store';
import { useToastStore } from '../state/toast-store';
import { PixelIcon } from './PixelIcon';

/**
 * Workspace-bar agent notification inbox (BridgeMind-style):
 * completed / needs-input / exited with jump-to-pane + mark read.
 */

function kindClass(kind: AgentNotificationKind): string {
  if (kind === 'completed') return 'agent-notif__item--completed';
  if (kind === 'needs_input') return 'agent-notif__item--needs';
  return 'agent-notif__item--exited';
}

function kindIcon(kind: AgentNotificationKind): string {
  if (kind === 'completed') return '✓';
  if (kind === 'needs_input') return '!';
  return '×';
}

function NotificationRow({
  item,
  now,
  onJump,
  onMarkRead,
}: {
  item: AgentNotification;
  now: number;
  onJump: (paneId: string) => void;
  onMarkRead: (id: string) => void;
}) {
  return (
    <li
      className={[
        'agent-notif__item',
        kindClass(item.kind),
        item.read ? 'agent-notif__item--read' : 'agent-notif__item--unread',
      ].join(' ')}
    >
      <span className="agent-notif__status-icon" aria-hidden="true">
        {kindIcon(item.kind)}
      </span>
      <div className="agent-notif__body">
        <div className="agent-notif__row-top">
          <span className="agent-notif__agent">{item.agentLabel}</span>
          <span className={`agent-notif__badge agent-notif__badge--${item.kind}`}>
            {agentNotificationStatusLabel(item.kind)}
          </span>
          <span className="agent-notif__ago">
            {formatNotificationAgo(now, item.createdAt)}
          </span>
        </div>
        <div className="agent-notif__actions">
          <button
            type="button"
            className="agent-notif__action agent-notif__action--primary"
            onClick={() => {
              onJump(item.paneId);
              onMarkRead(item.id);
            }}
          >
            Ir ao pane
          </button>
          {!item.read && (
            <button
              type="button"
              className="agent-notif__action"
              onClick={() => onMarkRead(item.id)}
            >
              Marcar lida
            </button>
          )}
        </div>
      </div>
    </li>
  );
}

export function AgentNotifications() {
  const items = useAgentNotificationStore((s) => s.items);
  const open = useAgentNotificationStore((s) => s.open);
  const setOpen = useAgentNotificationStore((s) => s.setOpen);
  const toggle = useAgentNotificationStore((s) => s.toggle);
  const markRead = useAgentNotificationStore((s) => s.markRead);
  const markAllRead = useAgentNotificationStore((s) => s.markAllRead);
  const clear = useAgentNotificationStore((s) => s.clear);
  const focus = useLayoutStore((s) => s.focus);
  const root = useLayoutStore((s) => s.root);
  const pushToast = useToastStore((s) => s.push);
  const rootRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const closeBtnRef = useRef<HTMLButtonElement>(null);
  const [now, setNow] = useState(() => Date.now());

  const unread = useMemo(() => countUnread(items), [items]);

  useEffect(() => {
    if (!open) return undefined;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, [open]);

  useEffect(() => {
    if (!open) return undefined;
    closeBtnRef.current?.focus();
    const onDoc = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        e.preventDefault();
        setOpen(false);
        return;
      }
      if (e.key !== 'Tab' || !panelRef.current) return;
      e.stopPropagation();
      const focusables = panelRef.current.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
      );
      if (focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const active = document.activeElement as HTMLElement | null;
      if (e.shiftKey && active === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('mousedown', onDoc);
    window.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [open, setOpen]);

  function jumpToPane(paneId: string) {
    const exists = listPanes(root).some((p) => p.id === paneId);
    if (!exists) {
      pushToast(
        'warn',
        'Pane fechado',
        'Esse agente já não está no grid — a notificação foi marcada como lida.',
      );
      return false;
    }
    focus(paneId);
    setOpen(false);
    return true;
  }

  return (
    <div className="agent-notif" ref={rootRef}>
      <button
        type="button"
        className={`agent-notif__bell ${unread > 0 ? 'agent-notif__bell--hot' : ''}`}
        title={
          unread > 0
            ? `Notificações — ${unread} não lida${unread === 1 ? '' : 's'}`
            : 'Notificações de agentes'
        }
        aria-label={
          unread > 0
            ? `Notificações de agentes, ${unread} não lidas`
            : 'Notificações de agentes'
        }
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => toggle()}
      >
        <PixelIcon name="bolt" size={12} />
        {unread > 0 && (
          <span className="agent-notif__count" aria-hidden="true">
            {unread > 9 ? '9+' : unread}
          </span>
        )}
      </button>

      {open && (
        <div
          ref={panelRef}
          className="agent-notif__panel"
          role="dialog"
          aria-modal="true"
          aria-label="Notificações de agentes"
        >
          <header className="agent-notif__head">
            <div className="agent-notif__head-left">
              <PixelIcon name="bolt" size={12} />
              <span className="agent-notif__title">Notificações</span>
              {unread > 0 && (
                <span className="agent-notif__unread-pill">
                  {unread} não lida{unread === 1 ? '' : 's'}
                </span>
              )}
            </div>
            <div className="agent-notif__head-actions">
              <button
                type="button"
                className="agent-notif__icon-btn"
                title="Marcar todas como lidas"
                aria-label="Marcar todas como lidas"
                disabled={unread === 0}
                onClick={() => markAllRead()}
              >
                ✓
              </button>
              <button
                type="button"
                className="agent-notif__icon-btn"
                title="Limpar lista"
                aria-label="Limpar notificações"
                disabled={items.length === 0}
                onClick={() => clear()}
              >
                ⌫
              </button>
              <button
                ref={closeBtnRef}
                type="button"
                className="agent-notif__icon-btn"
                title="Fechar"
                aria-label="Fechar notificações"
                onClick={() => setOpen(false)}
              >
                ×
              </button>
            </div>
          </header>

          {items.length === 0 ? (
            <p className="agent-notif__empty">
              Sem avisos ainda. Quando um agente terminar um turno sustentado
              ou encerrar, aparece aqui.
            </p>
          ) : (
            <ul className="agent-notif__list">
              {items.map((item) => (
                <NotificationRow
                  key={item.id}
                  item={item}
                  now={now}
                  onJump={(paneId) => {
                    jumpToPane(paneId);
                  }}
                  onMarkRead={markRead}
                />
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
