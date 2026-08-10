/** @vitest-environment jsdom */
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PaneModel } from '../../../shared/types';
import { buildGridTree } from '../../lib/split-tree';
import { useLayoutStore } from '../../state/layout-store';
import { TerminalWorkspace } from './TerminalWorkspace';

const terminalRuntime = vi.hoisted(() => ({
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
  waitForSession: vi.fn(async () => null as string | null),
  writeToPane: vi.fn(),
  applyTerminalSettings: vi.fn(),
  terminalRendererPerformanceSnapshot: vi.fn(() => ({
    performanceMode: 'adaptive' as const,
    hosts: 0,
    visibleHosts: 0,
    activeWebglLeases: 0,
    queuedTerminals: 0,
    queuedChars: 0,
    pendingParseChars: 0,
    droppedBacklogs: 0,
  })),
}));

const browserRuntime = vi.hoisted(() => ({
  attachBrowserPane: vi.fn(),
  reconcileBrowserPanes: vi.fn(),
  scheduleBrowserPaneBoundsSync: vi.fn(),
  setBrowserViewportOverride: vi.fn(),
  waitForBrowserPaneCreated: vi.fn(async () => undefined),
}));

vi.mock('../../terminal/terminal-host', () => terminalRuntime);
vi.mock('../../browser/browser-host', () => browserRuntime);
vi.mock('../CanvasView', () => ({
  CanvasView: () => <div className="canvas-container" />,
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

globalThis.ResizeObserver ??=
  ResizeObserverStub as unknown as typeof ResizeObserver;

const PANES: PaneModel[] = [
  { id: 'pane-canonical-a', kind: 'shell', title: 'Terminal A' },
  { id: 'pane-canonical-b', kind: 'shell', title: 'Terminal B' },
];
const CANONICAL_IDS = PANES.map((pane) => pane.id).sort();

type MountedRoot = {
  host: HTMLDivElement;
  root: Root;
  mounted: boolean;
};

const mountedRoots: MountedRoot[] = [];
let ptySpawn = vi.fn();

function mount(node: ReactNode): MountedRoot {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  const mounted = { host, root, mounted: true };
  mountedRoots.push(mounted);
  act(() => root.render(node));
  return mounted;
}

function unmount(mounted: MountedRoot): void {
  if (!mounted.mounted) return;
  act(() => mounted.root.unmount());
  mounted.mounted = false;
  mounted.host.remove();
}

function installNexusBoundary(): void {
  ptySpawn = vi.fn();
  Object.defineProperty(window, 'nexus', {
    configurable: true,
    value: {
      pty: { spawn: ptySpawn, write: vi.fn() },
      notes: {
        list: vi.fn(async () => []),
        save: vi.fn(async () => undefined),
        remove: vi.fn(async () => undefined),
        onChanged: vi.fn(() => vi.fn()),
      },
      pipes: {
        list: vi.fn(async () => []),
        add: vi.fn(async () => ({ ok: true, id: 'pipe-test' })),
        remove: vi.fn(async () => undefined),
        onChanged: vi.fn(() => vi.fn()),
      },
    },
  });
}

function seedLayout(viewKind: 'grid' | 'canvas' = 'grid'): void {
  useLayoutStore.setState({
    root: buildGridTree(PANES),
    focusedPaneId: PANES[0]!.id,
    maximizedPaneId: null,
    hydrated: true,
    viewKind,
    canvasNodeLayouts: {},
    canvasViewport: { x: 0, y: 0, zoom: 1 },
  });
}


function boardReturnButtons(host: HTMLElement): HTMLButtonElement[] {
  return [...host.querySelectorAll<HTMLButtonElement>('button')].filter((button) =>
    /voltar.*quadro/i.test(
      button.getAttribute('aria-label') ?? button.textContent ?? '',
    ),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  installNexusBoundary();
  seedLayout();
});

afterEach(() => {
  for (const mounted of mountedRoots.splice(0).reverse()) unmount(mounted);
  document.body.replaceChildren();
  Reflect.deleteProperty(window, 'nexus');
  vi.clearAllMocks();
});

describe('TerminalWorkspace contracts', () => {
  it('selects the canonical grid or canvas surface from layout state', () => {
    const { host } = mount(<TerminalWorkspace />);

    expect(host.querySelector('.grid')).not.toBeNull();
    expect(host.querySelector('.canvas-container')).toBeNull();

    act(() => useLayoutStore.setState({ viewKind: 'canvas' }));

    expect(host.querySelector('.canvas-container')).not.toBeNull();
    expect(host.querySelector('.grid')).toBeNull();
  });

  it('mounts every pane host while hidden and reveals the same canonical grid without reattaching', () => {
    const mounted = mount(<TerminalWorkspace hidden />);
    const workspace = mounted.host.querySelector<HTMLElement>(
      '.terminal-workspace',
    );
    const grid = mounted.host.querySelector('.grid');

    expect(workspace?.hidden).toBe(true);
    expect(workspace?.getAttribute('aria-hidden')).toBe('true');
    expect(grid).not.toBeNull();

    const attachedWhileHidden = terminalRuntime.attachHost.mock.calls.map(
      ([pane]) => (pane as PaneModel).id,
    );
    for (const paneId of CANONICAL_IDS) {
      expect(
        attachedWhileHidden.filter((id) => id === paneId),
      ).toHaveLength(1);
    }
    expect(terminalRuntime.reconcileHosts).toHaveBeenCalledTimes(1);

    act(() =>
      mounted.root.render(
        <TerminalWorkspace
          missionId="mission-release"
          onBackToBoard={vi.fn()}
        />,
      ),
    );

    expect(
      mounted.host.querySelector<HTMLElement>('.terminal-workspace'),
    ).toBe(workspace);
    expect(mounted.host.querySelector('.grid')).toBe(grid);
    expect(workspace?.hidden).toBe(false);
    expect(workspace?.hasAttribute('aria-hidden')).toBe(false);

    const attachedAfterReveal = terminalRuntime.attachHost.mock.calls.map(
      ([pane]) => (pane as PaneModel).id,
    );
    for (const paneId of CANONICAL_IDS) {
      expect(
        attachedAfterReveal.filter((id) => id === paneId),
      ).toHaveLength(1);
    }
    expect(terminalRuntime.reconcileHosts).toHaveBeenCalledTimes(1);
    expect(ptySpawn).not.toHaveBeenCalled();
  });

  it('exposes exactly one return-to-board action only in mission context', () => {
    const onBackToBoard = vi.fn();
    const mission = mount(
      <TerminalWorkspace
        missionId="mission-release"
        onBackToBoard={onBackToBoard}
      />,
    );

    const actions = boardReturnButtons(mission.host);
    expect(actions).toHaveLength(1);
    act(() => actions[0]!.click());
    expect(onBackToBoard).toHaveBeenCalledOnce();

    unmount(mission);
    const standalone = mount(<TerminalWorkspace />);
    expect(boardReturnButtons(standalone.host)).toHaveLength(0);
  });
});
