import { beforeEach, describe, expect, it } from 'vitest';
import {
  missionAgentSchema,
  missionSnapshotSchema,
  type MissionAgentSnapshot,
  type MissionSnapshot,
} from '../../shared/mission-engine-contract';
import { useMissionInspectorStore } from './mission-inspector-store';
import { inspectorTabForState } from './mission-inspector-store';

const INSPECTOR_TABS = [
  'agent',
  'plan',
  'chat',
  'activity',
  'team',
  'result',
] as const;

function agent(
  id: string,
  category: MissionAgentSnapshot['category'],
): MissionAgentSnapshot {
  return missionAgentSchema.parse({
    id,
    agentName: `Agente ${id}`,
    category,
    cli: 'codex',
    state: 'queued',
  });
}

function snapshot(
  id: string,
  agents: readonly MissionAgentSnapshot[],
  version = 1,
): MissionSnapshot {
  return missionSnapshotSchema.parse({
    id,
    title: `Missão ${id}`,
    objective: `Executar ${id}`,
    workspaceLabel: `Workspace ${id}`,
    state: 'running',
    progress: { completed: 0, total: 0 },
    agents: [...agents],
    edges: [],
    units: [],
    allowedActions: ['direct', 'stop'],
    version,
    updatedAt: version,
  });
}

const coordinator = agent('coordinator', 'orchestrator');
const worker = agent('worker', 'executor');
const reviewer = agent('reviewer', 'reviewer');

function resetStore(): void {
  useMissionInspectorStore.setState({
    missionId: null,
    tab: 'agent',
    selectedAgentId: null,
  });
}

describe('ephemeral mission inspector store', () => {
  beforeEach(resetStore);

  it.each(INSPECTOR_TABS)('selects the strict %s tab through its store action', (tab) => {
    useMissionInspectorStore.getState().selectTab(tab);

    expect(useMissionInspectorStore.getState().tab).toBe(tab);
  });

  it('opens the Agent tab whenever an agent is selected', () => {
    const store = useMissionInspectorStore.getState();
    store.bindSnapshot(snapshot('mission-a', [coordinator, worker]));
    store.selectTab('activity');

    store.selectAgent(worker.id);

    expect(useMissionInspectorStore.getState()).toMatchObject({
      missionId: 'mission-a',
      selectedAgentId: worker.id,
      tab: 'agent',
    });
  });

  it('binds an initial snapshot to its orchestrator even when it is not first', () => {
    useMissionInspectorStore
      .getState()
      .bindSnapshot(snapshot('mission-a', [worker, coordinator, reviewer]));

    expect(useMissionInspectorStore.getState()).toMatchObject({
      missionId: 'mission-a',
      selectedAgentId: coordinator.id,
    });
  });

  it('binds an initial malformed roster without an orchestrator to its first agent', () => {
    useMissionInspectorStore
      .getState()
      .bindSnapshot(snapshot('mission-a', [reviewer, worker]));

    expect(useMissionInspectorStore.getState().selectedAgentId).toBe(reviewer.id);
  });

  it('rebinds deterministically when mission identity changes even if the old selection still exists', () => {
    const store = useMissionInspectorStore.getState();
    store.bindSnapshot(snapshot('mission-a', [coordinator, worker]));
    store.selectAgent(worker.id);

    const nextCoordinator = agent('next-coordinator', 'orchestrator');
    store.bindSnapshot(
      snapshot('mission-b', [worker, reviewer, nextCoordinator]),
    );

    expect(useMissionInspectorStore.getState()).toMatchObject({
      missionId: 'mission-b',
      selectedAgentId: nextCoordinator.id,
    });
  });

  it('falls back to the first agent when a changed mission has no orchestrator', () => {
    const store = useMissionInspectorStore.getState();
    store.bindSnapshot(snapshot('mission-a', [coordinator, worker]));
    store.selectAgent(worker.id);

    store.bindSnapshot(snapshot('mission-b', [reviewer, worker]));

    expect(useMissionInspectorStore.getState()).toMatchObject({
      missionId: 'mission-b',
      selectedAgentId: reviewer.id,
    });
  });

  it('preserves a valid selection across canonical refreshes of the same mission', () => {
    const store = useMissionInspectorStore.getState();
    store.bindSnapshot(snapshot('mission-a', [coordinator, worker], 1));
    store.selectAgent(worker.id);

    store.bindSnapshot(snapshot('mission-a', [reviewer, worker, coordinator], 2));

    expect(useMissionInspectorStore.getState()).toMatchObject({
      missionId: 'mission-a',
      selectedAgentId: worker.id,
    });
  });

  it('resets a stale tab to Activity when the bound mission changes without an explicit route', () => {
    const store = useMissionInspectorStore.getState();
    store.bindSnapshot(snapshot('mission-a', [coordinator, worker]));
    store.selectTab('result');

    store.bindSnapshot(snapshot('mission-b', [coordinator, reviewer]));

    expect(useMissionInspectorStore.getState()).toMatchObject({
      missionId: 'mission-b',
      tab: 'activity',
    });
  });

  it.each([
    {
      label: 'the orchestrator',
      agents: [reviewer, coordinator] as const,
      expectedAgentId: coordinator.id,
    },
    {
      label: 'the first agent when no orchestrator exists',
      agents: [reviewer, agent('replacement-worker', 'executor')] as const,
      expectedAgentId: reviewer.id,
    },
  ])('rebinds to $label when the selected agent disappears', ({ agents, expectedAgentId }) => {
    const store = useMissionInspectorStore.getState();
    store.bindSnapshot(snapshot('mission-a', [coordinator, worker], 1));
    store.selectAgent(worker.id);

    store.bindSnapshot(snapshot('mission-a', agents, 2));

    expect(useMissionInspectorStore.getState().selectedAgentId).toBe(
      expectedAgentId,
    );
  });
});

describe('inspectorTabForState — a aba de abertura responde o estado', () => {
  it('entrega concluída abre no Resultado, não no log de eventos', () => {
    expect(inspectorTabForState('completed')).toBe('result');
  });

  it('pergunta pendente abre na Conversa', () => {
    expect(inspectorTabForState('blocked_user')).toBe('chat');
  });

  it('falha e recuperação abrem na Atividade', () => {
    expect(inspectorTabForState('failed')).toBe('activity');
    expect(inspectorTabForState('blocked_technical')).toBe('activity');
    expect(inspectorTabForState('recovering')).toBe('activity');
  });

  it('estado desconhecido cai na aba que nunca mente', () => {
    expect(inspectorTabForState(undefined)).toBe('activity');
    expect(inspectorTabForState('running')).toBe('activity');
  });

  it('nunca abre na aba Agente — ficha técnica não é a pergunta de quem chega', () => {
    for (const state of ['completed', 'blocked_user', 'failed', 'running']) {
      expect(inspectorTabForState(state)).not.toBe('agent');
    }
  });
});
