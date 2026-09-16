/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MissionSummarySnapshot } from '../../shared/mission-engine-contract';
import { useOrchBridge } from '../orch/orch-bridge';
import { setActiveWorkspacePath } from './active-workspace';
import { EMPTY_COST_SNAPSHOT, useCostController, useCostStore } from './cost-store';
import { useOrchStore } from './orch-store';
import { EMPTY_USAGE_SNAPSHOT, useUsageStore, useUsageSync } from './usage-store';
import { useWorkspaceStore } from './workspace-store';

vi.mock('../terminal/terminal-host', () => ({
  getPaneSessionId: vi.fn(() => null),
  onPaneSessionChange: vi.fn(() => vi.fn()),
  respawnWithResume: vi.fn(),
  waitForSession: vi.fn(async () => null),
}));

vi.mock('../browser/browser-host', () => ({
  waitForBrowserPaneCreated: vi.fn(async () => undefined),
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const workspace = (path: string) => ({
  path,
  name: path.split('/').at(-1) ?? path,
  lastOpenedAt: 1,
});

const costSnapshot = (totalUsd: number) => ({
  totalUsd,
  perMinuteUsd: 0,
  tokPerSec: 0,
  panes: [],
});

const usageSnapshot = (turns: number) => ({
  byPane: {},
  byAccount: {},
  global: { costUsd: 0, inputTokens: 0, outputTokens: 0, turns },
  media: { generations: 0, costUsd: 0 },
});

function missionSummary(
  id: string,
  updatedAt = 1,
): MissionSummarySnapshot {
  return {
    id,
    title: id,
    state: 'running',
    progress: { completed: 0, total: 1 },
    needsAttention: false,
    updatedAt,
  };
}

function listener(): ReturnType<typeof vi.fn> {
  return vi.fn(() => vi.fn());
}

function nexusApi() {
  return {
    mission: {
      list: vi.fn(async () => [] as MissionSummarySnapshot[]),
      onChanged: listener(),
    },
    orch: {
      listMissions: vi.fn(async () => []),
      listHandoffs: vi.fn(async () => []),
      getTodos: vi.fn(async () => []),
      listSquads: vi.fn(async () => []),
      getMcpInfo: vi.fn(async () => ({ running: true, url: null, toolCount: 1 })),
      onPaneSpawnRequest: listener(),
      onPaneRecoveryRequest: listener(),
      onBrowserOpenRequest: listener(),
      onPaneCloseRequest: listener(),
      onPaneParkRequest: listener(),
      onMissionsChanged: listener(),
      onHandoffsChanged: listener(),
      onTodosChanged: listener(),
      onSquadsChanged: listener(),
      syncPanes: vi.fn(),
      sendPaneSpawnResult: vi.fn(),
      sendPaneRecoveryResult: vi.fn(),
      sendBrowserOpenResult: vi.fn(),
    },
    cost: {
      snapshot: vi.fn(async () => costSnapshot(0)),
      setCap: vi.fn(async () => ({ ok: true })),
      onChanged: listener(),
    },
    usage: {
      snapshot: vi.fn(async () => usageSnapshot(0)),
      onChanged: listener(),
    },
  };
}

function Controllers(): null {
  useOrchBridge();
  useCostController();
  useUsageSync();
  return null;
}

function mount(): { root: Root; host: HTMLDivElement } {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => root.render(<Controllers />));
  return { root, host };
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

const initialWorkspace = useWorkspaceStore.getState();
const initialOrch = useOrchStore.getState();
const initialCost = useCostStore.getState();
const initialUsage = useUsageStore.getState();
let mounted: { root: Root; host: HTMLDivElement } | null = null;
let api: ReturnType<typeof nexusApi>;

describe('project-scoped renderer controllers', () => {
  beforeEach(() => {
    api = nexusApi();
    Object.defineProperty(window, 'nexus', { configurable: true, value: api });
    setActiveWorkspacePath(null);
    useWorkspaceStore.setState({ current: null, recents: [], hydrated: true });
    useOrchStore.setState({
      missions: [],
      missionSummaries: [],
      handoffs: [],
      todoLists: [],
      paneMissions: {},
      boundWorkspacePath: null,
      workspaceEpoch: 0,
    });
    useCostStore.setState({ snapshot: EMPTY_COST_SNAPSHOT });
    useUsageStore.setState({ snapshot: EMPTY_USAGE_SNAPSHOT });
  });

  afterEach(() => {
    if (mounted) act(() => mounted?.root.unmount());
    mounted?.host.remove();
    mounted = null;
    setActiveWorkspacePath(null);
    useWorkspaceStore.setState(initialWorkspace);
    useOrchStore.setState(initialOrch);
    useCostStore.setState(initialCost);
    useUsageStore.setState(initialUsage);
    Reflect.deleteProperty(window, 'nexus');
    vi.restoreAllMocks();
  });

  it('does not query project-scoped IPC while no workspace is authorized', async () => {
    mounted = mount();
    await flush();

    expect(api.orch.listMissions).not.toHaveBeenCalled();
    expect(api.mission.list).not.toHaveBeenCalled();
    expect(api.orch.listHandoffs).not.toHaveBeenCalled();
    expect(api.orch.getTodos).not.toHaveBeenCalled();
    expect(api.cost.snapshot).not.toHaveBeenCalled();
    expect(api.usage.snapshot).not.toHaveBeenCalled();
    expect(api.orch.onMissionsChanged).toHaveBeenCalledOnce();
    expect(api.mission.onChanged).toHaveBeenCalledOnce();
    expect(api.cost.onChanged).toHaveBeenCalledOnce();
    expect(api.usage.onChanged).toHaveBeenCalledOnce();
  });

  it('waits for workspace hydration even when a current path is present', async () => {
    setActiveWorkspacePath('/workspace/a');
    useWorkspaceStore.setState({
      current: workspace('/workspace/a'),
      hydrated: false,
    });

    mounted = mount();
    await flush();

    expect(api.orch.listMissions).not.toHaveBeenCalled();
    expect(api.mission.list).not.toHaveBeenCalled();
    expect(api.cost.snapshot).not.toHaveBeenCalled();
    expect(api.usage.snapshot).not.toHaveBeenCalled();
  });

  it('hydrates all project mirrors after workspace authorization completes', async () => {
    setActiveWorkspacePath('/workspace/a');
    useWorkspaceStore.setState({ current: workspace('/workspace/a'), hydrated: true });
    api.orch.listMissions.mockResolvedValue([{ id: 'mission-a' }] as never);
    api.mission.list.mockResolvedValue([missionSummary('summary-a')]);
    api.cost.snapshot.mockResolvedValue(costSnapshot(4));
    api.usage.snapshot.mockResolvedValue(usageSnapshot(7));

    mounted = mount();
    await flush();

    expect(api.orch.listMissions).toHaveBeenCalledOnce();
    expect(api.mission.list).toHaveBeenCalledOnce();
    expect(api.cost.snapshot).toHaveBeenCalledOnce();
    expect(api.usage.snapshot).toHaveBeenCalledOnce();
    expect(useOrchStore.getState().missions).toEqual([{ id: 'mission-a' }]);
    expect(useOrchStore.getState().missionSummaries).toEqual([
      missionSummary('summary-a'),
    ]);
    const onChanged = api.mission.onChanged.mock.calls[0]?.[0] as
      | ((items: MissionSummarySnapshot[]) => void)
      | undefined;
    if (!onChanged) throw new Error('missing canonical mission subscription');
    act(() => onChanged([missionSummary('summary-broadcast', 2)]));
    expect(useOrchStore.getState().missionSummaries).toEqual([
      missionSummary('summary-broadcast', 2),
    ]);
    expect(useCostStore.getState().snapshot.totalUsd).toBe(4);
    expect(useUsageStore.getState().snapshot.global.turns).toBe(7);
  });

  it('resets on A to B and discards late responses from A', async () => {
    const missionA = deferred<unknown[]>();
    const missionB = deferred<unknown[]>();
    const summaryA = deferred<MissionSummarySnapshot[]>();
    const summaryB = deferred<MissionSummarySnapshot[]>();
    const costA = deferred<ReturnType<typeof costSnapshot>>();
    const costB = deferred<ReturnType<typeof costSnapshot>>();
    const usageA = deferred<ReturnType<typeof usageSnapshot>>();
    const usageB = deferred<ReturnType<typeof usageSnapshot>>();
    api.orch.listMissions
      .mockReturnValueOnce(missionA.promise as never)
      .mockReturnValueOnce(missionB.promise as never);
    api.mission.list
      .mockReturnValueOnce(summaryA.promise)
      .mockReturnValueOnce(summaryB.promise);
    api.cost.snapshot
      .mockReturnValueOnce(costA.promise)
      .mockReturnValueOnce(costB.promise);
    api.usage.snapshot
      .mockReturnValueOnce(usageA.promise)
      .mockReturnValueOnce(usageB.promise);
    setActiveWorkspacePath('/workspace/a');
    useWorkspaceStore.setState({ current: workspace('/workspace/a'), hydrated: true });
    mounted = mount();
    await flush();
    useOrchStore.setState({
      missions: [{ id: 'visible-a' }] as never,
      missionSummaries: [missionSummary('visible-summary-a')],
    });
    useCostStore.setState({ snapshot: costSnapshot(10) });
    useUsageStore.setState({ snapshot: usageSnapshot(10) });

    act(() => {
      setActiveWorkspacePath('/workspace/b');
      useWorkspaceStore.setState({ current: workspace('/workspace/b'), hydrated: true });
    });
    await flush();

    expect(useOrchStore.getState().missions).toEqual([]);
    expect(useOrchStore.getState().missionSummaries).toEqual([]);
    expect(useCostStore.getState().snapshot).toEqual(EMPTY_COST_SNAPSHOT);
    expect(useUsageStore.getState().snapshot).toEqual(EMPTY_USAGE_SNAPSHOT);

    missionB.resolve([{ id: 'mission-b' }]);
    summaryB.resolve([missionSummary('summary-b')]);
    costB.resolve(costSnapshot(20));
    usageB.resolve(usageSnapshot(20));
    await flush();
    expect(useOrchStore.getState().missions).toEqual([{ id: 'mission-b' }]);
    expect(useOrchStore.getState().missionSummaries).toEqual([
      missionSummary('summary-b'),
    ]);
    expect(useCostStore.getState().snapshot.totalUsd).toBe(20);
    expect(useUsageStore.getState().snapshot.global.turns).toBe(20);

    missionA.resolve([{ id: 'late-a' }]);
    summaryA.resolve([missionSummary('late-summary-a', 99)]);
    costA.resolve(costSnapshot(99));
    usageA.resolve(usageSnapshot(99));
    await flush();
    expect(useOrchStore.getState().missions).toEqual([{ id: 'mission-b' }]);
    expect(useOrchStore.getState().missionSummaries).toEqual([
      missionSummary('summary-b'),
    ]);
    expect(useCostStore.getState().snapshot.totalUsd).toBe(20);
    expect(useUsageStore.getState().snapshot.global.turns).toBe(20);
  });

  it('resets project mirrors on close without making another scoped query', async () => {
    setActiveWorkspacePath('/workspace/a');
    useWorkspaceStore.setState({ current: workspace('/workspace/a'), hydrated: true });
    api.orch.listMissions.mockResolvedValue([{ id: 'mission-a' }] as never);
    api.mission.list.mockResolvedValue([missionSummary('summary-a')]);
    api.cost.snapshot.mockResolvedValue(costSnapshot(3));
    api.usage.snapshot.mockResolvedValue(usageSnapshot(5));
    mounted = mount();
    await flush();

    act(() => {
      setActiveWorkspacePath(null);
      useWorkspaceStore.setState({ current: null, hydrated: true });
    });
    await flush();

    expect(useOrchStore.getState().missions).toEqual([]);
    expect(useOrchStore.getState().missionSummaries).toEqual([]);
    expect(useCostStore.getState().snapshot).toEqual(EMPTY_COST_SNAPSHOT);
    expect(useUsageStore.getState().snapshot).toEqual(EMPTY_USAGE_SNAPSHOT);
    expect(api.orch.listMissions).toHaveBeenCalledOnce();
    expect(api.mission.list).toHaveBeenCalledOnce();
    expect(api.cost.snapshot).toHaveBeenCalledOnce();
    expect(api.usage.snapshot).toHaveBeenCalledOnce();
  });
});
