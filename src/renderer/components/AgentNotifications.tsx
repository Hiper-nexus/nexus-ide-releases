import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
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
import { useSettingsStore } from '../state/settings-store';
import { useOrchStore } from '../state/orch-store';
import { useOmpRpcStore } from '../state/omp-rpc-store';
import { useMemoryStore } from '../state/memory-store';
import { useConfigInventoryStore } from '../state/config-inventory-store';
import { useFilesStore } from '../state/files-store';
import { PixelIcon } from './PixelIcon';

/**
 * Workspace-bar agent notification inbox (BridgeMind-style):
 * completed / needs-input / exited with jump-to-pane + mark read.
 *
 * O painel é `position: fixed` ancorado abaixo do sino: a zona de status da
 * barra é `overflow:hidden` (trunca os chips), então um popover absoluto lá
 * dentro seria recortado — fixed escapa do clip.
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
  const status = agentNotificationStatusLabel(item.kind);
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
          <span className="agent-notif__agent" title={item.agentLabel}>
            {item.agentLabel}
          </span>
          <span className={`agent-notif__badge agent-notif__badge--${item.kind}`}>
            {status}
          </span>
          <span className="agent-notif__ago">
            {formatNotificationAgo(now, item.createdAt)}
          </span>
        </div>
        <div className="agent-notif__actions">
          <button
            type="button"
            className="agent-notif__action agent-notif__action--primary"
            aria-label={`Ir ao pane de ${item.agentLabel}`}
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
              aria-label={`Marcar notificação de ${item.agentLabel} como lida`}
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
  const pushToast = useToastStore((s) => s.push);

  // Popover é efêmero: qualquer drawer/painel maior que abra o fecha, para não
  // ficar flutuando por cima de uma superfície que tomou a tela.
  const anyDrawerOpen = useSettingsStore(
    (s) => s.drawerOpen,
  );
  const orchPanel = useOrchStore((s) => s.panelOpen);
  const boardOpen = useOrchStore((s) => s.boardOpen);
  const ompPanel = useOmpRpcStore((s) => s.panelOpen);
  const memoryPanel = useMemoryStore((s) => s.panelOpen);
  const configInv = useConfigInventoryStore((s) => s.open);
  const filesOpen = useFilesStore((s) => s.open);
  const surfaceOpen =
    anyDrawerOpen ||
    orchPanel ||
    boardOpen ||
    ompPanel ||
    memoryPanel ||
    configInv ||
    filesOpen;

  const rootRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const bellRef = useRef<HTMLButtonElement>(null);
  const closeBtnRef = useRef<HTMLButtonElement>(null);
  const restoreFocusRef = useRef(true);
  const [now, setNow] = useState(() => Date.now());
  const [anchor, setAnchor] = useState<{ top: number; right: number } | null>(
    null,
  );

  const unread = useMemo(() => countUnread(items), [items]);

  // aria-live: anuncia só quando um item NOVO entra no topo (não em marcar-lida).
  const [announce, setAnnounce] = useState('');
  const lastAnnouncedId = useRef<string | null>(null);
  const inited = useRef(false);
  useEffect(() => {
    const top = items[0];
    if (!inited.current) {
      inited.current = true;
      lastAnnouncedId.current = top?.id ?? null;
      return;
    }
    if (top && top.id !== lastAnnouncedId.current) {
      lastAnnouncedId.current = top.id;
      setAnnounce(
        `${top.agentLabel}: ${agentNotificationStatusLabel(top.kind)}`,
      );
    }
  }, [items]);

  useEffect(() => {
    if (surfaceOpen && open) setOpen(false);
  }, [surfaceOpen, open, setOpen]);

  useEffect(() => {
    if (!open) return undefined;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, [open]);

  // Posição fixed ancorada ao sino; recalcula em resize (e fecha em scroll do
  // conteúdo, que invalidaria a âncora).
  useLayoutEffect(() => {
    if (!open) {
      setAnchor(null);
      return undefined;
    }
    const compute = () => {
      const r = rootRef.current?.getBoundingClientRect();
      if (r) {
        setAnchor({
          top: Math.round(r.bottom + 8),
          right: Math.max(8, Math.round(window.innerWidth - r.right)),
        });
      }
    };
    compute();
    window.addEventListener('resize', compute);
    return () => window.removeEventListener('resize', compute);
  }, [open]);

  useEffect(() => {
    if (!open) return undefined;
    restoreFocusRef.current = true;
    closeBtnRef.current?.focus();
    const onDoc = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node) &&
          !panelRef.current?.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        // Nada atravessa o popover: um Esc fecha só ele, não o overlay de cima.
        e.stopImmediatePropagation();
        e.stopPropagation();
        e.preventDefault();
        setOpen(false);
        return;
      }
      if (e.key !== 'Tab' || !panelRef.current) return;
      e.stopImmediatePropagation();
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
      // Devolve o foco ao sino ao fechar — exceto quando pulamos para um pane.
      if (restoreFocusRef.current) bellRef.current?.focus();
    };
  }, [open, setOpen]);

  function jumpToPane(paneId: string) {
    // Lê o root VIVO: o pane pode ter fechado entre o push e este clique.
    const root = useLayoutStore.getState().root;
    const exists = listPanes(root).some((p) => p.id === paneId);
    if (!exists) {
      pushToast(
        'warn',
        'Pane fechado',
        'Esse agente já não está no grid — a notificação foi marcada como lida.',
      );
      return false;
    }
    restoreFocusRef.current = false; // foco vai para o pane, não volta ao sino
    focus(paneId);
    setOpen(false);
    return true;
  }

  return (
    <div className="agent-notif" ref={rootRef}>
      <span className="agent-notif__sr" role="status" aria-live="polite">
        {announce}
      </span>
      <button
        ref={bellRef}
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
        <PixelIcon name="bell" size={12} />
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
          aria-label="Notificações de agentes"
          style={
            anchor
              ? { position: 'fixed', top: anchor.top, right: anchor.right }
              : undefined
          }
        >
          <header className="agent-notif__head">
            <div className="agent-notif__head-left">
              <PixelIcon name="bell" size={12} />
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
