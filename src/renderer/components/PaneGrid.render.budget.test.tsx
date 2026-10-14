/** @vitest-environment jsdom */
// Inspired by pingdotgg/t3code @ 26285ab80513260d1ff29d2c3fbe18f21990cb62 (no code copied)
// Referência (T3 Code, MIT): só o método de
// packages/client-runtime/src/operations/commands.performance.test.ts (teto
// numérico pinado, CI falha quando passa), num teste do Nexus para o trabalho de render da
// grade de panes por broadcast do motor de missão — renders e assinaturas do
// store contados, nunca cronometrados.

/**
 * QLT-01 — orçamento de render da grade de panes por broadcast de missão.
 *
 * Grade real (PaneGrid → PaneLeaf → toolbar, superfície, faixa de atividade)
 * com 8 agentes ligados à mesma missão; o terminal e o browser são mocks. Cada
 * broadcast faz no store o que o orch-bridge faz ao receber
 * `onMissionsChanged` + `mission.onChanged`: lista de missões nova, summaries
 * novos e o rebind do pane do orquestrador. Como mudar um teto:
 * docs/perf-budgets.md.
 *
 * Tetos (valor medido no commit que criou o orçamento entre parênteses):
 * - paneRendersPerBroadcast (0): broadcast que não muda o que o pane mostra
 *   não re-renderiza pane nenhum. Protege 95a79996a (PaneToolbar e
 *   PaneInteractionSurface assinavam `missions`/`squads` inteiros: cada evento
 *   do motor custava 2 componentes × N panes de render).
 * - gridCommitsPerBroadcast (0): nenhum commit do React na árvore da grade.
 * - orchSubscriptionsPerPane (3): assinaturas vivas do orch-store por pane de
 *   agente (toolbar: categoria do agente; faixa de atividade: missão do pane e
 *   estado terminal). Assinatura nova no store inteiro custa N listeners.
 * - rebindNotifications (0): `bindPaneMission` do mesmo par é no-op e não
 *   acorda assinante (o orch-bridge chama em todo broadcast).
 */
import { act, memo, Profiler, type ComponentProps } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StateCreator, StoreApi } from 'zustand';
import type { MissionSummarySnapshot } from '../../shared/mission-engine-contract';
import type { Mission, Squad } from '../../shared/orch-types';
import type { PaneModel } from '../../shared/types';
import { buildGridTree } from '../lib/split-tree';
import { useLayoutStore } from '../state/layout-store';
import { useOrchStore } from '../state/orch-store';
import { PaneGrid } from './PaneGrid';

const BUDGET = {
  paneRendersPerBroadcast: 0,
  gridCommitsPerBroadcast: 0,
  orchSubscriptionsPerPane: 3,
  rebindNotifications: 0,
} as const;

const probe = vi.hoisted(() => ({
  renders: { toolbar: 0, surface: 0, activity: 0 },
  surfacePaneIds: [] as string[],
  /** listeners vivos por store criado com `create` do zustand. */
  liveListeners: new Map<unknown, Set<unknown>>(),
}));

// Conta assinaturas vivas: mesmo `create` do zustand, com `subscribe`
// embrulhado antes de o hook ser montado. O useStore real lê `api.subscribe`.
vi.mock('zustand', async (importOriginal) => {
  const actual = await importOriginal<typeof import('zustand')>();
  const { createStore } = await import('zustand/vanilla');
  const build = (createState: StateCreator<object>) => {
    const api: StoreApi<object> = createStore(createState);
    const listeners = new Set<unknown>();
    const subscribe = api.subscribe;
    api.subscribe = (listener) => {
      listeners.add(listener);
      const unsubscribe = subscribe(listener);
      return () => {
        listeners.delete(listener);
        unsubscribe();
      };
    };
    const useBoundStore = (selector?: (state: object) => unknown) =>
      selector ? actual.useStore(api, selector) : actual.useStore(api);
    Object.assign(useBoundStore, api);
    probe.liveListeners.set(useBoundStore, listeners);
    return useBoundStore;
  };
  return {
    ...actual,
    create: (createState?: StateCreator<object>) => (createState ? build(createState) : build),
  };
});

// Os componentes contados são chamados como função dentro do contador: os
// hooks deles passam a ser do contador, então re-render por assinatura própria
// também conta (um wrapper com createElement só contaria render do pai).
vi.mock('./PaneToolbar', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./PaneToolbar')>();
  return {
    ...actual,
    PaneToolbar: memo((props: ComponentProps<typeof actual.PaneToolbar>) => {
      probe.renders.toolbar += 1;
      return actual.PaneToolbar.type(props);
    }),
  };
});
vi.mock('./PaneInteractionSurface', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./PaneInteractionSurface')>();
  return {
    ...actual,
    PaneInteractionSurface: (props: ComponentProps<typeof actual.PaneInteractionSurface>) => {
      probe.renders.surface += 1;
      probe.surfacePaneIds.push(props.pane.id);
      return actual.PaneInteractionSurface(props);
    },
  };
});
vi.mock('./PaneActivityStrip', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./PaneActivityStrip')>();
  return {
    ...actual,
    PaneActivityStrip: memo((props: ComponentProps<typeof actual.PaneActivityStrip>) => {
      probe.renders.activity += 1;
      return actual.PaneActivityStrip.type(props);
    }),
  };
});

const terminal = vi.hoisted(() => ({
  attachHost: vi.fn(),
  blurHost: vi.fn(),
  focusHost: vi.fn(),
  setHostVisibility: vi.fn(),
  reconcileHosts: vi.fn(),
  refitAllPanesBeforePaint: vi.fn(),
  getPaneSessionId: vi.fn(() => null as string | null),
  getScrollbackExcerpt: vi.fn(() => ''),
  hibernateHost: vi.fn(),
  onPaneSessionChange: vi.fn(() => vi.fn()),
  respawnWithResume: vi.fn(),
  scrollPaneToBottom: vi.fn(),
  submitPromptToPane: vi.fn(() => true),
  wakeHost: vi.fn(),
  repaintPaneTui: vi.fn(),
  applyTerminalSettings: vi.fn(),
}));
vi.mock('../terminal/terminal-host', () => terminal);
vi.mock('../browser/browser-host', () => ({
  attachBrowserPane: vi.fn(),
  reconcileBrowserPanes: vi.fn(),
  waitForBrowserPaneCreated: vi.fn(async () => undefined),
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

class ObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

const PANES = 8;
const BROADCASTS = 20;
const MISSION_ID = 'mission-budget';

const panes: PaneModel[] = Array.from({ length: PANES }, (_, index) => ({
  id: `pane-${index}`,
  kind: 'cli-agent',
  title: index === 0 ? 'Maestro' : `Writer ${index}`,
  role: index === 0 ? 'orchestrator' : 'worker',
  agentName: index === 0 ? 'Maestro' : `Writer ${index}`,
  missionId: MISSION_ID,
}));

const squads: Squad[] = [];

function missionAt(tick: number): Mission {
  return {
    id: MISSION_ID,
    title: 'Orçamento de render',
    description: 'Broadcasts do motor sem mudança visível nos panes',
    status: 'running',
    squadId: 'squad-budget',
    milestones: [],
    learnings: `tick ${tick}`,
    createdAt: 1,
    updatedAt: 1 + tick,
  } as Mission;
}

function summaryAt(tick: number): MissionSummarySnapshot {
  return { id: MISSION_ID, state: 'running', updatedAt: 1 + tick } as unknown as MissionSummarySnapshot;
}

/** O que o orch-bridge faz no store a cada broadcast do motor de missão. */
function broadcast(tick: number): void {
  useOrchStore.setState({ missions: [missionAt(tick)] });
  useOrchStore.getState().bindPaneMission(panes[0]!.id, MISSION_ID);
  useOrchStore.setState({ missionSummaries: [summaryAt(tick)], missionSummariesHydrated: true });
}

function totalPaneRenders(): number {
  return probe.renders.toolbar + probe.renders.surface + probe.renders.activity;
}

let root: Root | null = null;

describe('orçamento de render da grade por broadcast de missão (QLT-01)', () => {
  beforeEach(() => {
    vi.stubGlobal('ResizeObserver', ObserverStub);
    vi.stubGlobal('IntersectionObserver', ObserverStub);
    Object.defineProperty(window, 'nexus', {
      configurable: true,
      value: {
        layout: {
          load: vi.fn(async () => ({ root: null, focusedPaneId: null })),
          save: vi.fn(async () => {}),
          saveSync: vi.fn(() => {}),
        },
        orch: { listMissionPanes: vi.fn(async () => []) },
      },
    });
    useOrchStore.setState({
      missions: [missionAt(0)],
      missionSummaries: [summaryAt(0)],
      missionSummariesHydrated: true,
      squads,
      paneMissions: Object.fromEntries(panes.map((pane) => [pane.id, MISSION_ID])),
    });
    useLayoutStore.setState({
      root: buildGridTree(panes),
      focusedPaneId: panes[0]!.id,
      maximizedPaneId: null,
      hydrated: true,
      stageFocusMode: false,
      stagePaneId: null,
    });
  });

  afterEach(() => {
    act(() => root?.unmount());
    root = null;
    Reflect.deleteProperty(window, 'nexus');
    document.body.replaceChildren();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it(`${PANES} agentes × ${BROADCASTS} broadcasts: renders, commits e assinaturas dentro do teto`, async () => {
    let gridCommits = 0;
    const orchListeners = probe.liveListeners.get(useOrchStore)!;
    // Assinaturas de módulo (fora da grade) não entram na conta por pane.
    const listenersBeforeMount = orchListeners.size;
    const host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => {
      root!.render(
        <Profiler id="pane-grid" onRender={() => (gridCommits += 1)}>
          <PaneGrid />
        </Profiler>,
      );
    });
    // Efeitos assíncronos da montagem (faixa de atividade lendo os panes da
    // missão) assentam antes da medição.
    await act(async () => {});
    expect(host.querySelectorAll('.pane')).toHaveLength(PANES);

    const subscriptionsPerPane = (orchListeners.size - listenersBeforeMount) / PANES;
    const rendersBefore = totalPaneRenders();
    const commitsBefore = gridCommits;

    for (let tick = 1; tick <= BROADCASTS; tick += 1) {
      act(() => broadcast(tick));
    }

    const work = {
      paneRendersPerBroadcast: (totalPaneRenders() - rendersBefore) / BROADCASTS,
      gridCommitsPerBroadcast: (gridCommits - commitsBefore) / BROADCASTS,
      orchSubscriptionsPerPane: subscriptionsPerPane,
      renders: { ...probe.renders },
    };
    console.info('[perf-budget] pane-grid broadcast', JSON.stringify(work));
    expect(work.paneRendersPerBroadcast).toBeLessThanOrEqual(BUDGET.paneRendersPerBroadcast);
    expect(work.gridCommitsPerBroadcast).toBeLessThanOrEqual(BUDGET.gridCommitsPerBroadcast);
    expect(work.orchSubscriptionsPerPane).toBeLessThanOrEqual(BUDGET.orchSubscriptionsPerPane);
  });

  it('rebind do mesmo pane → missão em todo broadcast não acorda assinante', () => {
    let notifications = 0;
    const unsubscribe = useOrchStore.subscribe(() => {
      notifications += 1;
    });
    try {
      for (let tick = 1; tick <= BROADCASTS; tick += 1) {
        for (const pane of panes) useOrchStore.getState().bindPaneMission(pane.id, MISSION_ID);
      }
    } finally {
      unsubscribe();
    }
    expect(notifications).toBeLessThanOrEqual(BUDGET.rebindNotifications);
  });

  it('clique de foco re-renderiza somente os dois panes envolvidos', async () => {
    const host = document.body.appendChild(document.createElement('div'));
    root = createRoot(host);
    act(() => root!.render(<PaneGrid />));
    await act(async () => {});
    probe.surfacePaneIds.length = 0;
    act(() => useLayoutStore.getState().focus(panes[1]!.id));
    expect([...new Set(probe.surfacePaneIds)].sort()).toEqual([panes[0]!.id, panes[1]!.id]);
    expect(host.querySelector('.pane--focused')?.textContent).toContain('Writer 1');
  });

  it('foco em Stage sem pane fixado continua escolhendo o palco', async () => {
    useLayoutStore.setState({ stageFocusMode: true, stagePaneId: null });
    const host = document.body.appendChild(document.createElement('div'));
    root = createRoot(host);
    act(() => root!.render(<PaneGrid />));
    await act(async () => {});
    act(() => useLayoutStore.getState().focus(panes[1]!.id));
    expect(host.querySelector('.panel--stage-main')?.textContent).toContain('Writer 1');
  });
});
