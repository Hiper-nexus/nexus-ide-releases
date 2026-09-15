/** @vitest-environment jsdom */
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PaneModel } from '../../../shared/types';
import { buildGridTree } from '../../lib/split-tree';
import { useLayoutStore } from '../../state/layout-store';
import { useOrchStore } from '../../state/orch-store';
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
  CanvasView: (props: {
    visiblePaneIds?: ReadonlySet<string>;
    onPaneCreated?: (paneId: string) => void;
  }) => {
    (globalThis as Record<string, unknown>).__nexusCanvasViewProps = props;
    return <div className="canvas-container" />;
  },
}));

function canvasViewProps(): {
  visiblePaneIds?: ReadonlySet<string>;
  onPaneCreated?: (paneId: string) => void;
} {
  return (
    ((globalThis as Record<string, unknown>).__nexusCanvasViewProps as {
      visiblePaneIds?: ReadonlySet<string>;
      onPaneCreated?: (paneId: string) => void;
    }) ?? {}
  );
}

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
  useOrchStore.setState({
    missions: [],
    missionSummaries: [],
    paneMissions: {},
  });
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

  it('mounts every pane host while hidden and does not dispose them when the mission view filters the mosaic', () => {
    const mounted = mount(<TerminalWorkspace hidden />);
    const workspace = mounted.host.querySelector<HTMLElement>(
      '.terminal-workspace',
    );

    expect(workspace?.hidden).toBe(true);
    expect(workspace?.getAttribute('aria-hidden')).toBe('true');
    expect(mounted.host.querySelector('.grid')).not.toBeNull();
    expect(mounted.host.querySelector('.grid--mission-empty')).toBeNull();

    const attachedWhileHidden = terminalRuntime.attachHost.mock.calls.map(
      ([pane]) => (pane as PaneModel).id,
    );
    for (const paneId of CANONICAL_IDS) {
      expect(
        attachedWhileHidden.filter((id) => id === paneId),
      ).toHaveLength(1);
    }
    expect(terminalRuntime.reconcileHosts).toHaveBeenCalledTimes(1);
    expect([...terminalRuntime.reconcileHosts.mock.calls[0]![0]].sort()).toEqual(
      CANONICAL_IDS,
    );

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
    expect(mounted.host.querySelector('.grid--mission-empty')).not.toBeNull();
    expect(workspace?.hidden).toBe(false);
    expect(workspace?.hasAttribute('aria-hidden')).toBe(false);

    expect(terminalRuntime.reconcileHosts).toHaveBeenCalledTimes(1);
    expect(ptySpawn).not.toHaveBeenCalled();
  });

  it('explica quando o filtro não tem panes em vez de entregar uma tela preta', () => {
    const { host } = mount(
      <TerminalWorkspace missionId="mission-without-panes" />,
    );

    expect(host.querySelector('.grid--mission-empty')).not.toBeNull();
    expect(host.textContent).toContain('Nenhum terminal visível');
  });

  it('Terminais da missão mostra só os panes dela, não o mosaico das 15', () => {
    useLayoutStore.setState({
      root: buildGridTree([
        {
          id: 'pane-maestro',
          kind: 'cli-agent',
          title: 'Maestro',
          adapterId: 'codex',
          missionId: 'mission-release',
        },
        {
          id: 'pane-other',
          kind: 'cli-agent',
          title: 'Outra',
          adapterId: 'codex',
          missionId: 'mission-other',
        },
      ]),
      focusedPaneId: 'pane-maestro',
    });
    useOrchStore.setState({
      paneMissions: {
        'pane-maestro': 'mission-release',
        'pane-other': 'mission-other',
      },
    });

    const { host } = mount(
      <TerminalWorkspace
        missionId="mission-release"
        onBackToBoard={vi.fn()}
      />,
    );

    expect(host.querySelector('.grid--mission-empty')).toBeNull();
    const attached = terminalRuntime.attachHost.mock.calls.map(
      ([pane]) => (pane as PaneModel).id,
    );
    expect(attached).toEqual(['pane-maestro']);
    expect(terminalRuntime.reconcileHosts).toHaveBeenCalledTimes(1);
    expect(
      [...terminalRuntime.reconcileHosts.mock.calls[0]![0]].sort(),
    ).toEqual(['pane-maestro', 'pane-other'].sort());
  });

  it('missão done sem aprovação humana mostra Pronto para revisar', () => {
    useOrchStore.setState({
      missions: [
        {
          id: 'mission-release',
          title: 'Landing',
          description: '',
          status: 'done',
          milestones: [],
          learnings: '',
          createdAt: 1,
          updatedAt: 2,
        },
      ],
      missionSummaries: [
        {
          id: 'mission-release',
          title: 'Landing',
          state: 'completed',
          progress: { completed: 1, total: 1 },
          needsAttention: false,
          updatedAt: 2,
        },
      ],
    });
    const { host } = mount(
      <TerminalWorkspace
        missionId="mission-release"
        onBackToBoard={vi.fn()}
      />,
    );
    const context = host.querySelector(
      '.product-workspace__context',
    )?.textContent;
    expect(context).toBe('Missão · Pronto para revisar');
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

describe('TerminalWorkspace em missão — "+ Pane" do operador', () => {
  const worker: PaneModel = {
    id: 'pane-w1',
    kind: 'cli-agent',
    title: 'Worker',
    adapterId: 'grok',
    missionId: 'm-1',
  };

  beforeEach(() => {
    // O picker rola a opção ativa para a vista; jsdom não implementa.
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: vi.fn(),
    });
    useLayoutStore.setState({
      root: buildGridTree([worker]),
      focusedPaneId: worker.id,
      maximizedPaneId: null,
    });
  });

  afterEach(() => {
    Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView');
  });

  function attachedIds(): string[] {
    return terminalRuntime.attachHost.mock.calls.map(
      ([pane]) => (pane as PaneModel).id,
    );
  }

  it('mostra só o pane da missão antes do operador criar algo', () => {
    mount(<TerminalWorkspace missionId="m-1" />);

    expect(attachedIds()).toEqual(['pane-w1']);
  });

  it('canvas: terminal criado na vista da missão é fixado no filtro', () => {
    useLayoutStore.setState({ viewKind: 'canvas' });
    mount(<TerminalWorkspace missionId="m-1" />);

    expect([...(canvasViewProps().visiblePaneIds ?? [])]).toEqual(['pane-w1']);
    expect(typeof canvasViewProps().onPaneCreated).toBe('function');

    // A barra do canvas cria o shell e avisa: o id entra no filtro da vista.
    act(() => canvasViewProps().onPaneCreated?.('pane-op'));
    expect([...(canvasViewProps().visiblePaneIds ?? [])]).toEqual(
      expect.arrayContaining(['pane-w1', 'pane-op']),
    );
  });

  it('o Terminal criado pelo picker monta na vista da missão (com PTY)', () => {
    const { host } = mount(<TerminalWorkspace missionId="m-1" />);
    expect(attachedIds()).toEqual(['pane-w1']);

    const trigger = host.querySelector<HTMLButtonElement>(
      '[data-testid="pane-picker-trigger"]',
    );
    if (!trigger) throw new Error('no "+ Pane" trigger rendered');
    act(() => trigger.click());
    const entry = host.querySelector<HTMLButtonElement>(
      '[data-testid="pane-picker-entry-type:terminal"]',
    );
    if (!entry) throw new Error('no Terminal entry rendered');
    act(() => entry.click());

    // Regressão: o filtro da missão escondia o shell criado (sem PaneLeaf,
    // sem PTY — "não abre, não faz nada"). Fixado, ele monta ao lado.
    // (attachHost pode refogar no remount do reshaping — a prova estável é
    // o slot montado no DOM, não a contagem de chamadas.)
    expect(host.querySelectorAll('.pane__terminal')).toHaveLength(2);
    expect(attachedIds()).toContain('pane-w1');
    const shellAttached = terminalRuntime.attachHost.mock.calls.some(
      ([pane]) => (pane as PaneModel).kind === 'shell',
    );
    expect(shellAttached).toBe(true);
  });
});

// ── F-527: vista global separa missões por chips de foco ─────────────────────

describe('TerminalWorkspace — filtro de missões na vista global (F-527)', () => {
  it('com 2+ missões vivas, abre focada na primeira e mostra chips', () => {
    useLayoutStore.setState({
      root: buildGridTree([
        {
          id: 'pane-a1',
          kind: 'cli-agent',
          title: 'Worker A1',
          adapterId: 'codex',
          missionId: 'mission-a',
        },
        {
          id: 'pane-b1',
          kind: 'cli-agent',
          title: 'Worker B1',
          adapterId: 'agy',
          missionId: 'mission-b',
        },
      ]),
      focusedPaneId: 'pane-a1',
    });
    useOrchStore.setState({
      paneMissions: {},
      missions: [],
      missionSummaries: [
        {
          id: 'mission-a',
          title: 'Checkout da loja',
          state: 'running',
          progress: { completed: 0, total: 1 },
          needsAttention: false,
          updatedAt: 1,
        },
        {
          id: 'mission-b',
          title: 'Blog da release',
          state: 'running',
          progress: { completed: 0, total: 1 },
          needsAttention: false,
          updatedAt: 2,
        },
      ],
    });

    const { host } = mount(<TerminalWorkspace />);

    const chips = [
      ...host.querySelectorAll('.terminal-workspace__filter-chip'),
    ];
    expect(chips.map((c) => c.textContent)).toEqual([
      'Checkout da loja',
      'Blog da release',
      'Todas as missões',
    ]);
    // Foco default: a primeira missão — só os panes dela montam.
    expect(
      host.querySelector('.terminal-workspace__filter-chip--active')
        ?.textContent,
    ).toBe('Checkout da loja');
    const attached = terminalRuntime.attachHost.mock.calls.map(
      ([pane]) => (pane as PaneModel).id,
    );
    expect(attached).toEqual(['pane-a1']);
  });
});
