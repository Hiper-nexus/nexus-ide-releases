/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AgentNotifications,
  notificationPanelPlacement,
} from './AgentNotifications';
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
const mountedRoots: Root[] = [];

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
  mountedRoots.push(root);
  return { host, root };
}

/**
 * O SINO fica na árvore da app (é a âncora medida); o PAINEL vive na camada de
 * overlay, portalado para fora de #root (H6 — src/renderer/overlay/). Buscar o
 * conteúdo do painel dentro do host de render passaria a não achar nada, então
 * a consulta é feita no documento — que é exatamente onde um usuário (e um
 * leitor de tela) o encontra.
 */
function inPanel<T extends HTMLElement>(selector: string): T | null {
  return document.querySelector<T>(`.agent-notif__panel ${selector}`);
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
    act(() => {
      for (const root of mountedRoots.splice(0)) root.unmount();
    });
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

  it('clamps the panel inside a narrow viewport when the bell is near the left edge', () => {
    expect(
      notificationPanelPlacement({
        anchor: { top: 20, right: 44, bottom: 46 },
        panelWidth: 296,
        viewport: { top: 0, left: 0, width: 320, height: 600 },
      }),
    ).toEqual({ top: 54, left: 8, maxHeight: 420 });
  });

  it('flips above the bell when a short viewport has more room there', () => {
    expect(
      notificationPanelPlacement({
        anchor: { top: 260, right: 390, bottom: 286 },
        panelWidth: 360,
        viewport: { top: 0, left: 0, width: 400, height: 320 },
      }),
    ).toEqual({ top: 28, left: 30, maxHeight: 224 });
  });

  it('opens on bell click and closes on ×, restoring focus to the bell', () => {
    seed('completed');
    const { host } = mount();
    const bell = host.querySelector<HTMLButtonElement>('.agent-notif__bell')!;
    act(() => bell.click());
    expect(useAgentNotificationStore.getState().open).toBe(true);
    expect(document.querySelector('.agent-notif__panel')).not.toBeNull();

    const closeBtn = Array.from(
      document.querySelectorAll<HTMLButtonElement>(
        '.agent-notif__panel .agent-notif__icon-btn',
      ),
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
    const jump = inPanel<HTMLButtonElement>('.agent-notif__action--primary')!;
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
      inPanel<HTMLButtonElement>('.agent-notif__action--primary')!.click(),
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
      inPanel('.agent-notif__action--primary')?.getAttribute('aria-label'),
    ).toBe('Ir ao pane de Claude');
  });

  it('H6: o painel sai da árvore da app; o sino fica', () => {
    seed('completed');
    const { host } = mount();
    act(() =>
      host.querySelector<HTMLButtonElement>('.agent-notif__bell')!.click(),
    );
    const panel = document.querySelector('.agent-notif__panel')!;
    expect(panel).not.toBeNull();
    // Dentro da .workspace-bar o painel herdava --z-app-chrome (55) e seu
    // z-index nunca disputava com um modal. Fora dela, disputa.
    expect(host.contains(panel)).toBe(false);
    expect(panel.closest('.overlay-layer')).not.toBeNull();
    expect(host.querySelector('.agent-notif__bell')).not.toBeNull();
  });
});
