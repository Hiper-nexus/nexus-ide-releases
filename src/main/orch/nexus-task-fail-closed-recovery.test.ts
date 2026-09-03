/**
 * Regressão (campo 03/09): com a missão aberta aguardando o ajuste do
 * operador, o runtime spawnou sozinho um worker duplicado ("Implementar
 * interface") que refez o review já entregue — retry enfileirado do
 * fail-closed descarregado sem olhar o hold de ajuste. Enquanto o marcador
 * awaiting-adjustment existir, flush é no-op: nada spawna antes de o humano
 * dizer qual é o ajuste.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mission } from '../../shared/orch-types';
import { testProjectScope } from './__tests__/scope-fixture';

const harness = vi.hoisted(() => ({
  mission: null as Mission | null,
  requestPaneSpawn: vi.fn(async () => ({ ok: true, paneId: 'pane-retry-1' })),
  getSquad: vi.fn(() => ({
    id: 'squad-1',
    agents: [
      {
        id: 'a-impl',
        agentName: 'Implementar interface',
        category: 'executor',
        cli: 'grok',
        model: 'grok-4.6',
        effort: 'xhigh',
      },
    ],
  })),
  recordMissionPane: vi.fn(),
}));

vi.mock('./pane-registry', () => ({
  listPaneSnapshots: () => [],
  requestPaneSpawn: (...args: unknown[]) =>
    (harness.requestPaneSpawn as (...a: unknown[]) => unknown)(...args),
}));

vi.mock('./project-domain-store-registry', () => ({
  getProjectDomainStores: () => ({
    missions: { get: () => harness.mission },
    missionPanes: { record: harness.recordMissionPane },
  }),
}));

vi.mock('./squad-store', () => ({
  getSquad: (...args: unknown[]) =>
    (harness.getSquad as (...a: unknown[]) => unknown)(...args),
}));

import {
  flushNexusTaskFailClosedRetry,
  noteFailedSpawnAttempt,
  resetNexusTaskFailClosedForTests,
} from './nexus-task-fail-closed-recovery';

const scope = testProjectScope();

function runningMission(description: string): Mission {
  return {
    id: 'mission-1',
    title: 'Prova',
    description,
    status: 'running',
    intentState: 'executing',
    intentVersion: 1,
    createdAt: 1,
    updatedAt: 1,
    squadId: 'squad-1',
    milestones: [],
    learnings: '',
  } as Mission;
}

function queueRetry(): void {
  noteFailedSpawnAttempt({
    missionId: 'mission-1',
    roleName: 'Implementar interface',
    category: 'executor',
    objective: 'analise o codigo',
  });
}

describe('flushNexusTaskFailClosedRetry — hold do "Pedir um ajuste"', () => {
  beforeEach(() => {
    resetNexusTaskFailClosedForTests();
    harness.requestPaneSpawn.mockClear();
    harness.getSquad.mockClear();
    harness.recordMissionPane.mockClear();
  });

  it('aguardando ajuste: retry enfileirado NÃO spawna sozinho', async () => {
    harness.mission = runningMission(
      'Refazer a tela.\n\n<!-- nexus:awaiting-adjustment:123 -->',
    );
    queueRetry();

    const result = await flushNexusTaskFailClosedRetry(scope, 'mission-1');

    expect(result).toBeNull();
    expect(harness.requestPaneSpawn).not.toHaveBeenCalled();
    expect(harness.getSquad).not.toHaveBeenCalled();
  });

  it('sem hold: retry enfileirado segue spawnando o papel', async () => {
    harness.mission = runningMission('Refazer a tela.');
    queueRetry();

    const result = await flushNexusTaskFailClosedRetry(scope, 'mission-1');

    expect(result).not.toBeNull();
    expect(result?.spawnedRoleIds).toContain('Implementar interface');
    expect(harness.requestPaneSpawn).toHaveBeenCalledTimes(1);
  });
});
