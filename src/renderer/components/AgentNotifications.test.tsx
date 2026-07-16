/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentNotifications } from './AgentNotifications';
import { useAgentNotificationStore } from '../state/agent-notification-store';
import { useLayoutStore } from '../state/layout-store';
import { useToastStore } from '../state/toast-store';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

const PANE = {
  id: 'pane-1',
  kind: 'cli-agent' as const,
  title: 'Claude',
  adapterId: 'claude',
  agentName: 'Claude',
};

function seedPane(present: boolean): void {
  useLayoutStore.setState({
    root: present
      ? { kind: 'leaf', id: 'leaf-1', pane: PANE }
      : { kind: 'leaf', id: 'leaf-1', pane: { ...PANE, id: 'other' } },
  } as never);
}

function seed(kind: 'completed' | 'exited', read = false): void {
  useAgentNotificationStore.setState({
    items: [
      {
        id: 'n1',
        paneId: 'pane-1',
        agentLabel: 'Claude',
        kind,
        createdAt: Date.now(),
        read,
      },
    ],
    open: false,
  });
}

function mount(): { host: HTMLDivElement; root: Root } {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => root.render(<AgentNotifications />));
  return { host, root };
}

describe('AgentNotifications', () => {
  beforeEach(() => {
    useAgentNotificationStore.setState({ items: [], open: false });
    seedPane(true);
    useToastStore.setState({ toasts: [] } as never);
    const focus = vi.fn();
    useLayoutStore.setState({ focus } as never);
  });

  afterEach(() => {
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  it('shows the unread count and caps it at 9+', () => {
    useAgentNotificationStore.setState({
      items: Array.from({ length: 12 }, (_, i) => ({
        id: `n${i}`,
        paneId: 'pane-1',
        agentLabel: 'Claude',
        kind: 'completed' as const,
        createdAt: Date.now(),
        read: false,
      })),
      open: false,
    });
    const { host } = mount();
    expect(host.querySelector('.agent-notif__count')?.textContent).toBe('9+');
    expect(
      host.querySelector('.agent-notif__bell')?.getAttribute('aria-label'),
    ).toContain('12 não lidas');
  });

  it('opens on bell click and closes on ×, restoring focus to the bell', () => {
    seed('completed');
    const { host } = mount();
    const bell = host.querySelector<HTMLButtonElement>('.agent-notif__bell')!;
    act(() => bell.click());
    expect(useAgentNotificationStore.getState().open).toBe(true);
    expect(host.querySelector('.agent-notif__panel')).not.toBeNull();

    const closeBtn = Array.from(
      host.querySelectorAll<HTMLButtonElement>('.agent-notif__icon-btn'),
    ).find((b) => b.getAttribute('aria-label') === 'Fechar notificações')!;
    act(() => closeBtn.click());
    expect(useAgentNotificationStore.getState().open).toBe(false);
    expect(document.activeElement).toBe(bell);
  });

  it('jump-to-pane on a live pane focuses it and closes the panel', () => {
    seed('completed');
    const focus = vi.fn();
    useLayoutStore.setState({ focus } as never);
    const { host } = mount();
    act(() =>
      host.querySelector<HTMLButtonElement>('.agent-notif__bell')!.click(),
    );
    const jump = host.querySelector<HTMLButtonElement>(
      '.agent-notif__action--primary',
    )!;
    act(() => jump.click());
    expect(focus).toHaveBeenCalledWith('pane-1');
    expect(useAgentNotificationStore.getState().open).toBe(false);
  });

  it('jump-to-pane on a dead pane warns via toast and marks read', () => {
    seed('completed');
    seedPane(false); // pane-1 não está mais no grid
    const pushToast = vi.fn();
    useToastStore.setState({ push: pushToast } as never);
    const { host } = mount();
    act(() =>
      host.querySelector<HTMLButtonElement>('.agent-notif__bell')!.click(),
    );
    act(() =>
      host
        .querySelector<HTMLButtonElement>('.agent-notif__action--primary')!
        .click(),
    );
    expect(pushToast).toHaveBeenCalledWith(
      'warn',
      expect.stringContaining('Pane fechado'),
      expect.any(String),
    );
    expect(useAgentNotificationStore.getState().items[0]?.read).toBe(true);
  });

  it('action buttons carry the agent name for screen readers', () => {
    seed('completed');
    const { host } = mount();
    act(() =>
      host.querySelector<HTMLButtonElement>('.agent-notif__bell')!.click(),
    );
    expect(
      host
        .querySelector('.agent-notif__action--primary')
        ?.getAttribute('aria-label'),
    ).toBe('Ir ao pane de Claude');
  });
});
