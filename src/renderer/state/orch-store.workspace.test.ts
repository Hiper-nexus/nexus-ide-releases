/** @vitest-environment jsdom */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_ONBOARDING } from '../../shared/onboarding-types';
import type { Handoff } from '../../shared/orch-types';
import { setActiveWorkspacePath } from './active-workspace';
import { useOnboardingStore } from './onboarding-store';
import { useOrchStore } from './orch-store';

describe('orch-store workspace isolation', () => {
  beforeEach(() => {
    setActiveWorkspacePath(null);
    Object.defineProperty(window, 'nexus', {
      configurable: true,
      value: {
        onboarding: { set: vi.fn(async () => DEFAULT_ONBOARDING) },
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
      handoffs: [],
      todoLists: [],
      squads: [],
      paneMissions: {},
      boundWorkspacePath: null,
      workspaceEpoch: 0,
    });
    useOnboardingStore.setState({
      state: DEFAULT_ONBOARDING,
      loaded: false,
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
    expect(useOrchStore.getState().boundWorkspacePath).toBeNull();

    const hydrateA = useOrchStore.getState().hydrate('/ws/a');
    // User switches away before A resolves.
    useOrchStore.getState().resetProjectState();
    setActiveWorkspacePath('/ws/b');
    deferred.resolve([]);
    await hydrateA;

    expect(useOrchStore.getState().boundWorkspacePath).toBeNull();
    expect(useOrchStore.getState().missions).toEqual([]);
  });
});
