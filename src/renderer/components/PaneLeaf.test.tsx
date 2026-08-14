/** @vitest-environment jsdom */
/**
 * Predicado da efervescência no pane vivo focado.
 * Garante que CoffeeSpillCorner (.spill-corner--live) aparece apenas
 * no pane focado e desaparece quando o foco muda.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PaneModel } from '../../shared/types';
import { buildGridTree } from '../lib/split-tree';
import { useLayoutStore } from '../state/layout-store';
import { PaneGrid } from './PaneGrid';

const terminal = vi.hoisted(() => ({
  attachHost: vi.fn(),
  blurHost: vi.fn(),
  focusHost: vi.fn(),
  setHostVisibility: vi.fn(),
  reconcileHosts: vi.fn(),
  getPaneSessionId: vi.fn(() => null as string | null),
  getScrollbackExcerpt: vi.fn(() => ''),
  hibernateHost: vi.fn(),
  onPaneSessionChange: vi.fn(() => vi.fn()),
  respawnWithResume: vi.fn(),
  scrollPaneToBottom: vi.fn(),
  submitPromptToPane: vi.fn(() => true),
  wakeHost: vi.fn(),
  applyTerminalSettings: vi.fn(),
}));

vi.mock('../terminal/terminal-host', () => terminal);
vi.mock('../browser/browser-host', () => ({
  attachBrowserPane: vi.fn(),
  reconcileBrowserPanes: vi.fn(),
  waitForBrowserPaneCreated: vi.fn(async () => undefined),
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
globalThis.ResizeObserver ??= ResizeObserverStub as unknown as typeof ResizeObserver;

class IntersectionObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
globalThis.IntersectionObserver ??=
  IntersectionObserverStub as unknown as typeof IntersectionObserver;

function shellPane(id: string): PaneModel {
  return { id, kind: 'shell', title: 'shell' };
}

let host: HTMLElement;
let root: Root;

function render(): void {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root.render(<PaneGrid />));
}

describe('CoffeeSpillCorner no pane vivo focado', () => {
  beforeEach(() => {
    Object.defineProperty(window, 'nexus', {
      configurable: true,
      value: {
        layout: {
          load: vi.fn(async () => ({ root: null, focusedPaneId: null, viewKind: 'grid' as const })),
          save: vi.fn(async () => {}),
          saveSync: vi.fn(() => {}),
        },
      },
    });
  });

  afterEach(() => {
    Reflect.deleteProperty(window, 'nexus');
    document.body.innerHTML = '';
    vi.clearAllMocks();
  });

  it('mostra .spill-corner--live no pane vivo focado', () => {
    const pane = shellPane('pane-a');
    useLayoutStore.setState({
      root: buildGridTree([pane]),
      focusedPaneId: pane.id,
      maximizedPaneId: null,
      hydrated: true,
      viewKind: 'grid',
    });

    render();

    const spill = host.querySelector('.spill-corner--live');
    expect(spill).not.toBeNull();
    expect(spill?.classList.contains('spill-corner')).toBe(true);
    expect(spill?.getAttribute('aria-hidden')).toBe('true');
    expect(spill?.querySelector('.spill__spray'), 'spray ao focar ausente').not.toBeNull();
    expect(spill?.querySelector('.spill__bubble'), 'bolhas ausentes').not.toBeNull();
    expect(spill?.querySelector('.spill__flash'), 'brilho de alumínio ausente').not.toBeNull();

    act(() => root.unmount());
  });

  it('NÃO mostra spill no pane vivo sem foco', () => {
    const paneA = shellPane('pane-a');
    const paneB = shellPane('pane-b');
    useLayoutStore.setState({
      root: buildGridTree([paneA, paneB]),
      focusedPaneId: paneB.id, // paneA não tem foco
      maximizedPaneId: null,
      hydrated: true,
      viewKind: 'grid',
    });

    render();

    const spills = host.querySelectorAll('.spill-corner--live');
    // Só um spill (no pane focado paneB), não dois
    expect(spills).toHaveLength(1);

    act(() => root.unmount());
  });

  it('move o spill quando o foco muda de pane', () => {
    const paneA = shellPane('pane-a');
    const paneB = shellPane('pane-b');
    useLayoutStore.setState({
      root: buildGridTree([paneA, paneB]),
      focusedPaneId: paneA.id,
      maximizedPaneId: null,
      hydrated: true,
      viewKind: 'grid',
    });

    render();

    expect(host.querySelectorAll('.spill-corner--live')).toHaveLength(1);

    // Muda o foco para paneB
    act(() => useLayoutStore.getState().focus(paneB.id));

    // Ainda um spill, agora no pane focado diferente
    expect(host.querySelectorAll('.spill-corner--live')).toHaveLength(1);

    act(() => root.unmount());
  });
});
