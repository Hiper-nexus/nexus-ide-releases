/** @vitest-environment jsdom */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MissionSummarySnapshot } from '../../shared/mission-engine-contract';
import type { Handoff, Mission } from '../../shared/orch-types';
import { setActiveWorkspacePath } from './active-workspace';
import { useOrchStore } from './orch-store';

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

describe('orch-store workspace isolation', () => {
  beforeEach(() => {
    setActiveWorkspacePath(null);
    Object.defineProperty(window, 'nexus', {
      configurable: true,
      value: {
        mission: {
          list: vi.fn(async () => []),
        },
        orch: {
          listMissions: vi.fn(async () => []),
          listHandoffs: vi.fn(async () => []),
          getTodos: vi.fn(async () => []),
          listSquads: vi.fn(async () => []),
          getMcpInfo: vi.fn(async () => ({
            running: true,
            url: null,
            toolCount: 0,
          })),
        },
      },
    });
    useOrchStore.setState({
      missions: [],
      missionSummaries: [],
      missionSummariesHydrated: false,
      handoffs: [],
      todoLists: [],
      squads: [],
      paneMissions: {},
      boundWorkspacePath: null,
      workspaceEpoch: 0,
    });
  });

  it('drops setMissions while unbound (workspace switch)', () => {
    setActiveWorkspacePath('/ws/a');
    useOrchStore.getState().setMissions([
      {
        id: 'leak',
        title: 'from previous',
        description: '',
        status: 'pending',
        milestones: [],
        learnings: '',
        createdAt: 1,
        updatedAt: 1,
      },
    ]);
    expect(useOrchStore.getState().missions).toEqual([]);
  });

  it('accepts setMissions only for the bound workspace path', () => {
    setActiveWorkspacePath('/ws/a');
    useOrchStore.setState({ boundWorkspacePath: '/ws/a' });
    useOrchStore.getState().setMissions([
      {
        id: 'ok',
        title: 'local',
        description: '',
        status: 'running',
        milestones: [],
        learnings: '',
        createdAt: 1,
        updatedAt: 2,
      },
    ]);
    expect(useOrchStore.getState().missions).toHaveLength(1);
    expect(useOrchStore.getState().missions[0]?.id).toBe('ok');

    // Switch active path without rebinding → reject foreign payload.
    setActiveWorkspacePath('/ws/b');
    useOrchStore.getState().setMissions([
      {
        id: 'foreign',
        title: 'other',
        description: '',
        status: 'pending',
        milestones: [],
        learnings: '',
        createdAt: 1,
        updatedAt: 1,
      },
    ]);
    expect(useOrchStore.getState().missions[0]?.id).toBe('ok');
  });

  it('accepts canonical summaries only while bound to the active workspace', () => {
    setActiveWorkspacePath('/ws/a');
    useOrchStore.getState().setMissionSummaries([
      missionSummary('unbound'),
    ]);
    expect(useOrchStore.getState().missionSummaries).toEqual([]);

    useOrchStore.setState({ boundWorkspacePath: '/ws/a' });
    useOrchStore.getState().setMissionSummaries([
      missionSummary('workspace-a'),
    ]);
    expect(useOrchStore.getState().missionSummaries).toEqual([
      missionSummary('workspace-a'),
    ]);

    setActiveWorkspacePath('/ws/b');
    useOrchStore.getState().setMissionSummaries([
      missionSummary('foreign'),
    ]);
    expect(useOrchStore.getState().missionSummaries).toEqual([
      missionSummary('workspace-a'),
    ]);
  });

  it('hydrates canonical summaries for the authorized workspace', async () => {
    setActiveWorkspacePath('/ws/a');
    const summaries = [missionSummary('restored-summary')];
    vi.mocked(window.nexus.mission.list).mockResolvedValue(summaries);

    await useOrchStore.getState().hydrate('/ws/a');

    expect(window.nexus.mission.list).toHaveBeenCalledOnce();
    expect(useOrchStore.getState().missionSummaries).toEqual(summaries);
    expect(useOrchStore.getState().missionSummariesHydrated).toBe(true);
    expect(useOrchStore.getState().missions).toEqual([]);
  });

  it('preserves a canonical changed broadcast newer than the deferred list', async () => {
    setActiveWorkspacePath('/ws/a');
    let resolveSummaries!: (items: MissionSummarySnapshot[]) => void;
    const pendingSummaries = new Promise<MissionSummarySnapshot[]>((resolve) => {
      resolveSummaries = resolve;
    });
    vi.mocked(window.nexus.mission.list).mockReturnValue(pendingSummaries);

    const hydration = useOrchStore.getState().hydrate('/ws/a');
    expect(useOrchStore.getState().boundWorkspacePath).toBe('/ws/a');
    const broadcast = [missionSummary('newer-broadcast', 2)];
    useOrchStore.getState().setMissionSummaries(broadcast);
    resolveSummaries([missionSummary('stale-list', 1)]);
    await hydration;

    expect(useOrchStore.getState().missionSummaries).toEqual(broadcast);
  });

  it('hydrates canonical summaries without waiting for the legacy mission list', async () => {
    setActiveWorkspacePath('/ws/a');
    let resolveLegacy!: (missions: Mission[]) => void;
    const pendingLegacy = new Promise<Mission[]>((resolve) => {
      resolveLegacy = resolve;
    });
    vi.mocked(window.nexus.orch.listMissions).mockReturnValue(pendingLegacy);
    vi.mocked(window.nexus.mission.list).mockResolvedValue([
      missionSummary('canonical-ready'),
    ]);

    const hydration = useOrchStore.getState().hydrate('/ws/a');
    await vi.waitFor(() =>
      expect(useOrchStore.getState().missionSummaries).toEqual([
        missionSummary('canonical-ready'),
      ]),
    );
    resolveLegacy([]);
    await hydration;
  });

  it('hydrates the legacy mission mirror without waiting for canonical summaries', async () => {
    setActiveWorkspacePath('/ws/a');
    let resolveCanonical!: (items: MissionSummarySnapshot[]) => void;
    const pendingCanonical = new Promise<MissionSummarySnapshot[]>((resolve) => {
      resolveCanonical = resolve;
    });
    const legacy: Mission = {
      id: 'legacy-ready',
      title: 'Legacy ready',
      description: '',
      status: 'running',
      milestones: [],
      learnings: '',
      createdAt: 1,
      updatedAt: 2,
    };
    vi.mocked(window.nexus.orch.listMissions).mockResolvedValue([legacy]);
    vi.mocked(window.nexus.mission.list).mockReturnValue(pendingCanonical);

    const hydration = useOrchStore.getState().hydrate('/ws/a');
    await vi.waitFor(() =>
      expect(useOrchStore.getState().missions).toEqual([legacy]),
    );
    resolveCanonical([]);
    await hydration;
  });

  it.each(['getMcpInfo', 'listHandoffs'] as const)(
    'hydrates and binds missions when auxiliary %s fails',
    async (failingAuxiliary) => {
      setActiveWorkspacePath('/ws/a');
      const mission = {
        id: 'restored',
        title: 'Missão restaurada',
        description: '',
        status: 'running' as const,
        milestones: [],
        learnings: '',
        createdAt: 1,
        updatedAt: 2,
      };
      const orch = window.nexus.orch;
      vi.mocked(orch.listMissions).mockResolvedValue([mission]);
      vi.mocked(orch[failingAuxiliary]).mockRejectedValue(
        new Error(`${failingAuxiliary} unavailable`),
      );
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

      await useOrchStore.getState().hydrate('/ws/a');

      expect(useOrchStore.getState().boundWorkspacePath).toBe('/ws/a');
      expect(useOrchStore.getState().missions).toEqual([mission]);

      useOrchStore.getState().setMissions([]);
      expect(useOrchStore.getState().missions).toEqual([]);
      expect(warn).toHaveBeenCalled();
      warn.mockRestore();
    },
  );

  it('binds before auxiliaries settle and never overwrites a later broadcast', async () => {
    setActiveWorkspacePath('/ws/a');
    let resolveHandoffs!: (handoffs: Handoff[]) => void;
    const pendingHandoffs = new Promise<Handoff[]>((resolve) => {
      resolveHandoffs = resolve;
    });
    const orch = window.nexus.orch;
    vi.mocked(orch.listHandoffs).mockReturnValue(pendingHandoffs);

    const hydration = useOrchStore.getState().hydrate('/ws/a');
    await vi.waitFor(() => {
      expect(useOrchStore.getState().boundWorkspacePath).toBe('/ws/a');
    });

    const handoff = (id: string): Handoff => ({
      id,
      status: 'progress',
      claimTrust: 'untrusted',
      summary: id,
      artifacts: [],
      evidenceIds: [],
      evidenceTrust: 'unverified',
      delivered: false,
      deliveryState: 'submitted',
      createdAt: 1,
    });
    useOrchStore.getState().setHandoffs([handoff('broadcast')]);
    resolveHandoffs([handoff('stale-snapshot')]);
    await hydration;

    expect(useOrchStore.getState().handoffs[0]?.id).toBe('broadcast');
  });

  it('binds at hydrate start and preserves a missionsChanged broadcast newer than the deferred snapshot', async () => {
    setActiveWorkspacePath('/ws/a');
    let resolveMissions!: (
      missions: Awaited<ReturnType<typeof window.nexus.orch.listMissions>>,
    ) => void;
    const pendingMissions = new Promise<
      Awaited<ReturnType<typeof window.nexus.orch.listMissions>>
    >((resolve) => {
      resolveMissions = resolve;
    });
    vi.mocked(window.nexus.orch.listMissions).mockReturnValue(pendingMissions);

    const stale = {
      id: 'stale-snapshot',
      title: 'Snapshot antigo',
      description: '',
      status: 'pending' as const,
      milestones: [],
      learnings: '',
      createdAt: 1,
      updatedAt: 1,
    };
    const broadcast = {
      ...stale,
      id: 'newer-broadcast',
      title: 'Broadcast novo',
      status: 'running' as const,
      updatedAt: 2,
    };

    const hydration = useOrchStore.getState().hydrate('/ws/a');
    expect(useOrchStore.getState().boundWorkspacePath).toBe('/ws/a');

    useOrchStore.getState().setMissions([broadcast]);
    resolveMissions([stale]);
    await hydration;

    expect(useOrchStore.getState().missions).toEqual([broadcast]);
  });

  it('reset clears missions and unbinds so late hydrate cannot paint old folder', async () => {
    setActiveWorkspacePath('/ws/a');
    useOrchStore.setState({
      boundWorkspacePath: '/ws/a',
      missionSummaries: [missionSummary('old-summary')],
      missions: [
        {
          id: 'old',
          title: 'old',
          description: '',
          status: 'done',
          milestones: [],
          learnings: '',
          createdAt: 1,
          updatedAt: 1,
        },
      ],
    });

    const deferred = (() => {
      let resolve!: (v: unknown) => void;
      const promise = new Promise((r) => {
        resolve = r;
      });
      return { promise, resolve };
    })();

    Object.defineProperty(window, 'nexus', {
      configurable: true,
      value: {
        mission: {
          list: vi.fn(async () => deferred.promise),
        },
        orch: {
          listMissions: vi.fn(async () => deferred.promise),
          listHandoffs: vi.fn(async () => []),
          getTodos: vi.fn(async () => []),
          listSquads: vi.fn(async () => []),
          getMcpInfo: vi.fn(async () => ({
            running: true,
            url: null,
            toolCount: 0,
          })),
        },
      },
    });

    useOrchStore.getState().resetProjectState();
    expect(useOrchStore.getState().missions).toEqual([]);
    expect(useOrchStore.getState().missionSummaries).toEqual([]);
    expect(useOrchStore.getState().boundWorkspacePath).toBeNull();

    const hydrateA = useOrchStore.getState().hydrate('/ws/a');
    // User switches away before A resolves.
    useOrchStore.getState().resetProjectState();
    setActiveWorkspacePath('/ws/b');
    deferred.resolve([]);
    await hydrateA;

    expect(useOrchStore.getState().boundWorkspacePath).toBeNull();
    expect(useOrchStore.getState().missions).toEqual([]);
    expect(useOrchStore.getState().missionSummaries).toEqual([]);
  });
});
