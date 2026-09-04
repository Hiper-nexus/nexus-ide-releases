import { useEffect, useMemo } from 'react';
import {
  attentionKindBadge,
  collectAttentionItems,
  type AttentionItem,
  type AttentionKind,
} from '../../shared/attention-inbox';
import { listPanes } from '../lib/split-tree';
import {
  attentionCauseForMissionState,
  routeMissionAttention,
} from '../lib/mission-attention-route';
import { useAttentionInboxStore } from '../state/attention-inbox-store';
import { useAgentNotificationStore } from '../state/agent-notification-store';
import { useAgentWaitingStore } from '../state/agent-waiting-store';
import { useContextualPanelNavStore } from '../state/contextual-panel-nav-store';
import { useGitScmStore } from '../state/git-scm-store';
import { useLayoutStore } from '../state/layout-store';
import { useOrchStore } from '../state/orch-store';
import { useProductNavigationStore } from '../state/product-navigation-store';
import { useProviderStore } from '../state/provider-store';
import { PixelIcon, type PixelIconName } from './PixelIcon';
import { ProviderLogo } from './ProviderLogo';
import { openCliLoginTerminal } from './settings/cli-login-terminal';

function kindIcon(kind: AttentionKind): PixelIconName {
  if (kind === 'cli-login') return 'key';
  if (kind === 'enter') return 'terminal';
  if (kind === 'mission-stuck') return 'mission';
  return 'files';
}

function jump(item: AttentionItem): void {
  if (item.kind === 'cli-login') {
    const provider = useProviderStore
      .getState()
      .providers.find((candidate) => candidate.adapterId === item.targetId);
    const command = provider?.loginCommand?.trim() ?? '';
    if (command.length > 0 && command.length <= 200 && !/[\r\n]/.test(command)) {
      void openCliLoginTerminal({
        command,
        adapterId: item.targetId,
        adapterLabel: provider?.label,
        onFinished: () => {
          void useProviderStore.getState().hydrate();
        },
      });
      return;
    }
    useProductNavigationStore.getState().openSettings('providers');
    return;
  }
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
    // A causa vem do estado: missão falhada não pode abrir numa aba Conversa
    // vazia, nem entrega concluída no log de eventos.
    const state = useOrchStore
      .getState()
      .missionSummaries.find((mission) => mission.id === item.targetId)?.state;
    routeMissionAttention({
      missionId: item.targetId,
      cause: attentionCauseForMissionState(state),
    });
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
        className="agent-notif__panel agent-notif__panel--rail overlay-enter"
        role="dialog"
        aria-label="Lista de atenção"
        style={{
          position: 'fixed',
          top: 'auto',
          right: 'auto',
          bottom: 16,
          left: 'calc(var(--nexus-shell-rail-width, 250px) + 12px)',
        }}
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
                <span className="agent-notif__status-icon" aria-hidden="true">
                  {item.kind === 'cli-login' ? (
                    <ProviderLogo
                      adapterId={item.targetId}
                      label={item.title}
                      size="xs"
                    />
                  ) : (
                    <PixelIcon name={kindIcon(item.kind)} size={12} />
                  )}
                </span>
                <div className="agent-notif__body">
                  <div className="agent-notif__row-top">
                    <span className="agent-notif__agent" title={item.title}>
                      {item.title}
                    </span>
                    <span className="agent-notif__badge">{attentionKindBadge(item.kind)}</span>
                  </div>
                  <p className="agent-notif__detail">{item.detail}</p>
                  <div className="agent-notif__actions">
                    <button
                      type="button"
                      className="agent-notif__action agent-notif__action--primary"
                      aria-label={item.actionLabel}
                      onClick={() => {
                        jump(item);
                        setOpen(false);
                      }}
                    >
                      {item.kind === 'cli-login' ? 'Entrar' : 'Abrir'}
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
