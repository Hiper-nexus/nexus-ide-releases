import { useEffect, useMemo } from 'react';
import { collectAttentionItems, type AttentionItem } from '../../shared/attention-inbox';
import { listPanes } from '../lib/split-tree';
import { routeMissionAttention } from '../lib/mission-attention-route';
import { useAttentionInboxStore } from '../state/attention-inbox-store';
import { useAgentNotificationStore } from '../state/agent-notification-store';
import { useAgentWaitingStore } from '../state/agent-waiting-store';
import { useContextualPanelNavStore } from '../state/contextual-panel-nav-store';
import { useGitScmStore } from '../state/git-scm-store';
import { useLayoutStore } from '../state/layout-store';
import { useOrchStore } from '../state/orch-store';
import { useProductNavigationStore } from '../state/product-navigation-store';
import { useProviderStore } from '../state/provider-store';
import { PixelIcon } from './PixelIcon';

function jump(item: AttentionItem): void {
  if (item.kind === 'enter') {
    const pane = listPanes(useLayoutStore.getState().root).find(
      (candidate) => candidate.id === item.targetId,
    );
    if (pane?.missionId) {
      routeMissionAttention({
        missionId: pane.missionId,
        cause: 'human-input',
        notificationPaneId: pane.id,
      });
    } else {
      useProductNavigationStore.getState().openTerminal();
      useLayoutStore.getState().focus(item.targetId);
    }
    return;
  }
  if (item.kind === 'pr-queue') {
    useContextualPanelNavStore.getState().openTab('git', { focus: true });
    return;
  }
  if (item.kind === 'mission-stuck') {
    useProductNavigationStore.getState().openMission(item.targetId);
    return;
  }
  useProductNavigationStore.getState().openSettings('providers');
}

export function AttentionInbox() {
  const open = useAttentionInboxStore((s) => s.open);
  const setOpen = useAttentionInboxStore((s) => s.setOpen);
  const notifications = useAgentNotificationStore((s) => s.items);
  const waitingSnapshot = useAgentWaitingStore((s) => s.snapshot);
  const pr = useGitScmStore((s) => s.pr);
  const missions = useOrchStore((s) => s.missionSummaries);
  const providers = useProviderStore((s) => s.providers);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopImmediatePropagation();
      setOpen(false);
    };
    window.addEventListener('keydown', onKey, { capture: true });
    return () => window.removeEventListener('keydown', onKey, { capture: true });
  }, [open, setOpen]);

  const items = useMemo(
    () =>
      collectAttentionItems({
        notifications,
        waitingAgents: [...waitingSnapshot.entries.values()],
        pr: pr
          ? {
              number: pr.number,
              title: pr.title,
              autoMergeEnabled: pr.autoMergeEnabled,
              mergeQueueRequired: pr.mergeQueueRequired,
            }
          : null,
        missions,
        providers,
      }),
    [notifications, waitingSnapshot, pr, missions, providers],
  );

  const setCount = useAttentionInboxStore((s) => s.setCount);
  useEffect(() => {
    setCount(items.length);
  }, [items.length, setCount]);

  if (!open) return null;

  return (
      <div
        className="agent-notif__panel overlay-enter"
        role="dialog"
        aria-label="Lista de atenção"
        style={{ position: 'fixed', top: 56, right: 16, left: 'auto' }}
      >
        <header className="agent-notif__head">
          <div className="agent-notif__head-left">
            <PixelIcon name="warn" size={12} />
            <span className="agent-notif__title">Atenção</span>
            {items.length > 0 && (
              <span className="agent-notif__unread-pill">{items.length}</span>
            )}
          </div>
          <button
            type="button"
            className="agent-notif__icon-btn"
            aria-label="Fechar lista de atenção"
            onClick={() => setOpen(false)}
          >
            ×
          </button>
        </header>
        {items.length === 0 ? (
          <p className="agent-notif__empty">Nada pedindo a sua ação agora.</p>
        ) : (
          <ul className="agent-notif__list">
            {items.map((item) => (
              <li key={item.id} className="agent-notif__item agent-notif__item--unread">
                <div className="agent-notif__body">
                  <div className="agent-notif__row-top">
                    <span className="agent-notif__agent">{item.title}</span>
                  </div>
                  <p className="agent-notif__ago">{item.detail}</p>
                  <div className="agent-notif__actions">
                    <button
                      type="button"
                      className="agent-notif__action agent-notif__action--primary"
                      onClick={() => {
                        jump(item);
                        setOpen(false);
                      }}
                    >
                      Ir
                    </button>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
  );
}
