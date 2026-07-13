/** @vitest-environment jsdom */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { setActiveWorkspacePath } from './active-workspace';
import { useOrchStore } from './orch-store';

describe('orch-store workspace isolation', () => {
  beforeEach(() => {
    setActiveWorkspacePath(null);
    Object.defineProperty(window, 'nexus', {
      configurable: true,
      value: {
        onboarding: { set: vi.fn(async () => ({})) },
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
