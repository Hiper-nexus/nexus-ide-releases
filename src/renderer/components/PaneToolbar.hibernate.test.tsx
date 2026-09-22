/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PaneModel } from '../../shared/types';
import { useSessionStateStore } from '../state/session-state-store';

const power = vi.hoisted(() => ({
  hibernateHost: vi.fn(() => true),
  wakeHost: vi.fn(() => true),
  askConfirm: vi.fn(async () => true),
}));

vi.mock('../terminal/terminal-host', () => ({
  hibernateHost: power.hibernateHost,
  wakeHost: power.wakeHost,
  respawnWithResume: vi.fn(),
  scrollPaneToBottom: vi.fn(),
  getPaneSessionId: vi.fn(() => null),
  onPaneSessionChange: vi.fn(() => vi.fn()),
}));
vi.mock('../state/confirm-store', () => ({ askConfirm: power.askConfirm }));
vi.mock('../terminal/pane-close-guard', () => ({ requestPaneClose: vi.fn() }));
vi.mock('./CostBadge', () => ({ CostBadge: () => null }));
vi.mock('./DevServerChip', () => ({ DevServerChip: () => null }));
vi.mock('./ProviderLogo', () => ({ ProviderLogo: () => null }));
vi.mock('./CommandBlockMenu', () => ({ CommandBlockMenu: () => null }));
vi.mock('./AgentAvatar', () => ({
  AgentAvatar: () => null,
  resolveAgentCategory: () => undefined,
}));
vi.mock('./PixelIcon', () => ({ PixelIcon: () => null }));

import { PaneToolbar } from './PaneToolbar';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

const pane: PaneModel = {
  id: 'agent-a',
  kind: 'cli-agent',
  title: 'Worker A',
  adapterId: 'codex',
};

function mount(): { host: HTMLDivElement; root: Root } {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => root.render(<PaneToolbar pane={pane} isFocused />));
  return { host, root };
}

describe('PaneToolbar hibernate/wake regression', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useSessionStateStore.setState({
      paneStates: new Map([[pane.id, 'idle']]),
      displayStates: new Map([[pane.id, 'idle']]),
    });
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('hibernates an idle agent immediately and wakes the same pane identity', () => {
    const first = mount();
    const sleep = first.host.querySelector<HTMLButtonElement>(
      'button[aria-label="Dormir"]',
    );
    expect(sleep).not.toBeNull();
    act(() => sleep!.click());
    expect(power.hibernateHost).toHaveBeenCalledWith(pane.id);
    expect(power.askConfirm).not.toHaveBeenCalled();
    act(() => first.root.unmount());

    act(() => {
      useSessionStateStore.getState().setPaneState(pane.id, 'hibernated');
    });
    const second = mount();
    const wake = second.host.querySelector<HTMLButtonElement>(
      'button[aria-label="Acordar"]',
    );
    expect(wake).not.toBeNull();
    act(() => wake!.click());
    expect(power.wakeHost).toHaveBeenCalledWith(pane);
    act(() => second.root.unmount());
  });

  it('requires explicit confirmation before killing a busy agent', async () => {
    act(() => {
      useSessionStateStore.getState().setPaneState(pane.id, 'busy');
    });
    power.askConfirm.mockResolvedValueOnce(false);
    const { host, root } = mount();
    const sleep = host.querySelector<HTMLButtonElement>(
      'button[aria-label="Dormir"]',
    );

    await act(async () => sleep!.click());
    expect(power.askConfirm).toHaveBeenCalledWith(
      expect.objectContaining({ danger: true }),
    );
    expect(power.hibernateHost).not.toHaveBeenCalled();
    act(() => root.unmount());
  });

  it('não põe "Tornar orquestrador" na fileira de ícones, ao lado de Ampliar', () => {
    const { host, root } = mount();
    const inline = host.querySelector('.toolbar__actions button[aria-label*="orquestrador" i]');
    expect(inline).toBeNull();
    act(() => root.unmount());
  });

  it('oferece "Tornar este pane o orquestrador" no menu "…", em grupo próprio após separador', () => {
    const { host, root } = mount();
    const trigger = host.querySelector<HTMLButtonElement>(
      'button[aria-label="Mais ações do pane"]',
    );
    expect(trigger).not.toBeNull();
    act(() => trigger!.click());

    const menu = document.querySelector<HTMLElement>('.toolbar__menu[role="menu"]');
    expect(menu).not.toBeNull();
    const promote = menu!.querySelector<HTMLButtonElement>(
      'button[role="menuitem"][aria-label="Tornar este pane o orquestrador"]',
    );
    expect(promote).not.toBeNull();
    expect(promote?.textContent).toContain('Tornar este pane o orquestrador');
    act(() => promote!.click());
    expect(document.querySelector('.toolbar__menu')).toBeNull();
    act(() => root.unmount());
  });

  it('em pane estreito, separa a troca de papel das ações de sessão/layout', () => {
    let measure: ((width: number) => void) | null = null;
    vi.stubGlobal('ResizeObserver', class {
      constructor(callback: ResizeObserverCallback) {
        measure = (width) =>
          callback([{ contentRect: { width } } as ResizeObserverEntry], this as unknown as ResizeObserver);
      }
      observe() {}
      disconnect() {}
    });
    try {
      const { host, root } = mount();
      act(() => measure?.(300));
      act(() =>
        host.querySelector<HTMLButtonElement>('button[aria-label="Mais ações do pane"]')!.click(),
      );
      const menu = document.querySelector<HTMLElement>('.toolbar__menu')!;
      const items = [...menu.querySelectorAll('[role="menuitem"]')];
      expect(items.length).toBeGreaterThan(1);
      const promote = items.at(-1)!;
      expect(promote.getAttribute('aria-label')).toBe('Tornar este pane o orquestrador');
      expect(promote.previousElementSibling?.getAttribute('role')).toBe('separator');
      act(() => root.unmount());
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('exibe o botão "Orquestrador" ativo quando o pane tem papel orchestrator', () => {
    const orchPane: PaneModel = {
      ...pane,
      role: 'orchestrator',
    };
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    act(() => root.render(<PaneToolbar pane={orchPane} isFocused />));

    const leaderBtn = host.querySelector<HTMLButtonElement>(
      'button[aria-label="Orquestrador"]',
    );
    expect(leaderBtn).not.toBeNull();
    expect(leaderBtn?.classList.contains('toolbar__btn--active')).toBe(true);
    act(() => root.unmount());
  });
});
