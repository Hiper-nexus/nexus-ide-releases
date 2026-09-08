/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PaneModel } from '../../shared/types';
import { buildGridTree } from '../lib/split-tree';
import { useLayoutStore } from '../state/layout-store';
import { useSessionStateStore } from '../state/session-state-store';

const close = vi.hoisted(() => vi.fn());
vi.mock('../terminal/pane-close-guard', () => ({ requestPaneClose: close }));
vi.mock('../terminal/terminal-host', () => ({
  hibernateHost: vi.fn(), wakeHost: vi.fn(), respawnWithResume: vi.fn(), scrollPaneToBottom: vi.fn(),
  getPaneSessionId: vi.fn(() => null),
}));
vi.mock('./CostBadge', () => ({ CostBadge: () => null }));
vi.mock('./DevServerChip', () => ({ DevServerChip: () => null }));
vi.mock('./CommandBlockMenu', () => ({ CommandBlockMenu: () => null }));
vi.mock('./AgentAvatar', () => ({ AgentAvatar: () => null, resolveAgentCategory: () => undefined }));
vi.mock('./ProviderLogo', () => ({ ProviderLogo: () => null }));
vi.mock('./PixelIcon', () => ({ PixelIcon: () => null }));

import { PaneToolbar } from './PaneToolbar';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let measure!: (width: number) => void;
const roots: Root[] = [];
const pane: PaneModel = { id: 'narrow-toolbar', kind: 'shell', title: 'Terminal' };

function mount(width: number): HTMLElement {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  roots.push(root);
  act(() => root.render(<PaneToolbar pane={pane} isFocused />));
  act(() => measure(width));
  return host;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('ResizeObserver', class {
    constructor(callback: ResizeObserverCallback) {
      measure = width => callback([{ contentRect: { width } } as ResizeObserverEntry], this as unknown as ResizeObserver);
    }
    observe() {}
    disconnect() {}
  });
  useLayoutStore.setState({ root: buildGridTree([pane]), focusedPaneId: pane.id, maximizedPaneId: null });
  useSessionStateStore.setState({ paneStates: new Map(), displayStates: new Map() });
});

afterEach(() => {
  act(() => roots.splice(0).forEach(root => root.unmount()));
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

describe('PaneToolbar narrow controls', () => {
  it('keeps readable icon controls instead of crowded full labels on a medium pane', () => {
    const host = mount(600);
    const maximize = host.querySelector<HTMLButtonElement>('.toolbar__actions [aria-label="Ampliar"]');
    expect(maximize).not.toBeNull();
    expect(maximize?.querySelector('.toolbar__btn-label')).toBeNull();
    act(() => maximize!.click());
    expect(useLayoutStore.getState().maximizedPaneId).toBe(pane.id);
  });

  it.each([120, 160, 240])('moves optional actions to the existing menu at %ipx and retains the guarded close action', width => {
    const host = mount(width);
    const inline = host.querySelector('.toolbar__actions');
    expect([...inline!.querySelectorAll('button')].map(button => button.ariaLabel)).toEqual(['Mais ações do pane']);
    const closeButton = host.querySelector<HTMLButtonElement>('[aria-label="Fechar este pane"]');
    expect(closeButton).not.toBeNull();
    act(() => closeButton!.click());
    expect(close).toHaveBeenCalledExactlyOnceWith(pane.id, undefined, {
      hasLiveSession: false,
    });
  });

  it('opens layout actions outside the clipped pane and returns keyboard focus on Escape', () => {
    const host = mount(120);
    const trigger = host.querySelector<HTMLButtonElement>('[aria-label="Mais ações do pane"]')!;
    act(() => trigger.click());
    const menu = document.querySelector('[role="menu"]');
    expect(menu).not.toBeNull();
    expect(host.contains(menu)).toBe(false);
    expect(menu?.querySelector('[aria-label="À direita"]')).not.toBeNull();
    expect(menu?.querySelector('[aria-label="Abaixo"]')).not.toBeNull();
    expect(menu?.contains(document.activeElement)).toBe(true);
    const canvasShortcut = vi.fn();
    window.addEventListener('keydown', canvasShortcut);
    const escape = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    try {
      act(() => document.activeElement!.dispatchEvent(escape));
      expect(escape.defaultPrevented).toBe(true);
      expect(canvasShortcut).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener('keydown', canvasShortcut);
    }
    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('keeps the maximize behavior reachable from the compact menu', () => {
    const host = mount(160);
    const trigger = host.querySelector<HTMLButtonElement>('[aria-label="Mais ações do pane"]')!;
    act(() => trigger.click());
    const maximize = document.querySelector<HTMLButtonElement>('[role="menu"] [aria-label="Ampliar"]');
    expect(maximize).not.toBeNull();
    act(() => maximize!.click());
    expect(useLayoutStore.getState().maximizedPaneId).toBe(pane.id);
    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('navigates menu items with arrows, Home and End without reaching canvas shortcuts', () => {
    const host = mount(120);
    const canvasShortcut = vi.fn();
    document.addEventListener('keydown', canvasShortcut);
    try {
      act(() => host.querySelector<HTMLButtonElement>('[aria-label="Mais ações do pane"]')!.click());
      const items = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')];
      const transitions = [
        ['ArrowDown', items[1]], ['ArrowUp', items[0]], ['ArrowUp', items.at(-1)],
        ['Home', items[0]], ['End', items.at(-1)], ['ArrowDown', items[0]],
      ] as const;
      for (const [key, target] of transitions) {
        const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
        act(() => document.activeElement!.dispatchEvent(event));
        expect(document.activeElement).toBe(target);
        expect(event.defaultPrevented).toBe(true);
      }
      expect(canvasShortcut).not.toHaveBeenCalled();
    } finally {
      document.removeEventListener('keydown', canvasShortcut);
    }
  });
});
