import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MissionSummarySnapshot } from '../../shared/mission-engine-contract';
import { setActiveWorkspacePath } from './active-workspace';
import { useOrchStore } from './orch-store';

/**
 * O bug do histórico de missões: bindings pane→missão eram append-only, então
 * panes mortos deixavam a missão antiga "aberta" para sempre (clique no-op,
 * sem "retomar"). O prune por panes vivos é a regressão que trava o conserto.
 */

describe('orch-store paneMissions', () => {
  beforeEach(() => {
    useOrchStore.setState({ paneMissions: {} });
  });

  it('bindPaneMission com missionId undefined não cria entrada', () => {
    useOrchStore.getState().bindPaneMission('pane-1', undefined);
    expect(useOrchStore.getState().paneMissions).toEqual({});
  });

  it('pruneMissionBindings derruba bindings de panes que saíram do layout', () => {
    const store = useOrchStore.getState();
    store.bindPaneMission('pane-a', 'mission-A');
    store.bindPaneMission('pane-b', 'mission-A');
    store.bindPaneMission('pane-c', 'mission-B');

    // Missão B substitui o grid: só o pane-c continua vivo.
    useOrchStore.getState().pruneMissionBindings(new Set(['pane-c']));

    expect(useOrchStore.getState().paneMissions).toEqual({
      'pane-c': 'mission-B',
    });
  });

  it('a missão deslocada deixa de contar como aberta (o bug reportado)', () => {
    const store = useOrchStore.getState();
    store.bindPaneMission('pane-a', 'mission-A');
    // grid substituído pela missão nova; pane-a morreu
    useOrchStore.getState().pruneMissionBindings(new Set(['pane-novo']));

    const openIds = new Set(
      Object.values(useOrchStore.getState().paneMissions),
    );
    expect(openIds.has('mission-A')).toBe(false); // agora o "retomar" aparece
  });

  it('sem mudança, o prune preserva o mesmo objeto de estado (sem re-render)', () => {
    useOrchStore.getState().bindPaneMission('pane-a', 'mission-A');
    const before = useOrchStore.getState().paneMissions;
    useOrchStore.getState().pruneMissionBindings(new Set(['pane-a']));
    expect(useOrchStore.getState().paneMissions).toBe(before);
  });
});

describe('orch-store canonical mission summaries', () => {
  const summary: MissionSummarySnapshot = {
    id: 'mission-canonical',
    title: 'Canonical mission',
    state: 'running',
    progress: { completed: 0, total: 1 },
    needsAttention: false,
    updatedAt: 2,
  };

  beforeEach(() => {
    setActiveWorkspacePath('/workspace/a');
    useOrchStore.setState({
      missions: [],
      missionSummaries: [],
      missionSummariesHydrated: false,
      boundWorkspacePath: '/workspace/a',
    });
  });

  it('stores canonical summaries without mutating the separate legacy mission mirror', () => {
    const legacyMission = {
      id: 'legacy',
      title: 'Legacy mission',
      description: 'Old product payload',
      status: 'running' as const,
      milestones: [],
      learnings: '',
      createdAt: 1,
      updatedAt: 2,
    };
    useOrchStore.setState({ missions: [legacyMission] });

    useOrchStore.getState().setMissionSummaries([summary]);

    expect(useOrchStore.getState().missionSummaries).toEqual([summary]);
    expect(useOrchStore.getState().missions).toEqual([legacyMission]);
  });

  it('distinguishes an authoritative empty snapshot from a workspace waiting for hydration', () => {
    expect(useOrchStore.getState().missionSummariesHydrated).toBe(false);
    useOrchStore.getState().setMissionSummaries([]);
    expect(useOrchStore.getState().missionSummariesHydrated).toBe(true);
    useOrchStore.getState().resetProjectState();
    expect(useOrchStore.getState().missionSummariesHydrated).toBe(false);
  });

  it('broadcast idêntico, inclusive chaves reordenadas, não notifica assinantes', () => {
    const mission = {
      id: 'm-unchanged', title: 'A', description: '', status: 'running' as const,
      milestones: [], learnings: '', createdAt: 1, updatedAt: 2,
    };
    useOrchStore.getState().setMissions([mission]);
    useOrchStore.getState().setMissionSummaries([summary]);
    const before = useOrchStore.getState();
    const notify = vi.fn();
    const unsubscribe = useOrchStore.subscribe(notify);
    try {
      useOrchStore.getState().setMissions([structuredClone(mission)]);
      useOrchStore.getState().setMissionSummaries([
        Object.fromEntries(Object.entries(structuredClone(summary)).reverse()) as MissionSummarySnapshot,
      ]);
      expect(notify).not.toHaveBeenCalled();
      expect(useOrchStore.getState()).toBe(before);
    } finally { unsubscribe(); }
  });

  it('estado, motivo, progresso e título novos passam mesmo com updatedAt igual', () => {
    useOrchStore.getState().setMissionSummaries([summary]);
    for (const patch of [
      { state: 'completed' as const },
      { stateReason: { code: 'awaiting-instruction', label: 'Aguardando' } },
      { progress: { completed: 1, total: 1 } },
      { title: 'Renamed' },
      { updatedAt: 3 },
    ]) {
      const next = { ...summary, ...patch };
      useOrchStore.getState().setMissionSummaries([next]);
      expect(useOrchStore.getState().missionSummaries).toEqual([next]);
    }
  });

  it('lista de missões mantém ordem, status e identidade da liderança atualizados', () => {
    const mission = {
      id: 'm-a', title: 'A', description: '', status: 'running' as const,
      milestones: [], learnings: '', createdAt: 1, updatedAt: 2,
    };
    const sibling = { ...mission, id: 'm-b' };
    useOrchStore.getState().setMissions([mission, sibling]);
    useOrchStore.getState().setMissions([sibling, mission]);
    expect(useOrchStore.getState().missions[0]!.id).toBe('m-b');
    const changed = { ...mission, orchestratorSessionId: 'new-session', status: 'blocked' as const };
    useOrchStore.getState().setMissions([changed]);
    expect(useOrchStore.getState().missions).toEqual([changed]);
  });
});
