import { describe, expect, it } from 'vitest';
import type { MissionPaneSpec, PaneSnapshot } from '../../shared/orch-types';
import type { ProjectExecutionScope } from '../../shared/types';
import { countLiveMissionWorkerSlots } from './mission-driver-io';

const scope: ProjectExecutionScope = {
  version: 1,
  installationId: 'install-a',
  projectId: 'project-a',
  checkoutId: 'checkout-a',
  rootRealPath: '/tmp/project-a',
  identitySource: 'manifest',
};

const MISSION = 'mission-1';

function workerRow(id: string, paneId?: string): MissionPaneSpec {
  return {
    id: `row-${id}`,
    missionId: MISSION,
    adapterId: 'claude',
    title: `Worker ${id}`,
    role: 'worker',
    ...(paneId ? { paneId } : {}),
  } as MissionPaneSpec;
}

function snapshot(
  paneId: string,
  state: PaneSnapshot['state'],
): PaneSnapshot {
  return {
    paneId,
    missionId: MISSION,
    role: 'worker',
    state,
    scope,
  } as unknown as PaneSnapshot;
}

describe('countLiveMissionWorkerSlots', () => {
  it('não conta workers mortos como slots ocupados (deadlock de campo)', () => {
    // Regressão: o gate de maxWorkers contava LINHAS duráveis de
    // mission_panes, que nunca são podadas — 3 workers mortos = missão
    // permanentemente sem spawn, sem cura nem por restart.
    const rows = [workerRow('a', 'pane-a'), workerRow('b', 'pane-b'), workerRow('c', 'pane-c')];
    const snapshots = [
      snapshot('pane-a', 'exited'),
      snapshot('pane-b', 'exited'),
      snapshot('pane-c', 'busy'),
    ];
    const result = countLiveMissionWorkerSlots(scope, MISSION, rows, snapshots);
    expect(result.live).toBe(1);
    expect(result.deadPaneIds).toEqual(['pane-a', 'pane-b']);
  });

  it('worker sem snapshot conta como morto quando o workspace está espelhado', () => {
    // Pane fechado é removido da árvore: sem snapshot. Com o scope espelhado
    // (outro pane do mesmo scope presente), ausência é evidência de morte.
    const rows = [workerRow('a', 'pane-a'), workerRow('b', 'pane-b')];
    const snapshots = [snapshot('pane-b', 'idle')];
    const result = countLiveMissionWorkerSlots(scope, MISSION, rows, snapshots);
    expect(result.live).toBe(1);
    expect(result.deadPaneIds).toEqual(['pane-a']);
  });

  it('fail-safe: sem workspace espelhado ninguém é dado como morto', () => {
    // Renderer ainda não espelhou o scope (boot/crash): ausência de snapshot
    // NÃO é evidência — contar como vivo evita exceder maxWorkers.
    const rows = [workerRow('a', 'pane-a'), workerRow('b', 'pane-b')];
    const result = countLiveMissionWorkerSlots(scope, MISSION, rows, []);
    expect(result.live).toBe(2);
    expect(result.deadPaneIds).toEqual([]);
  });

  it('fail-safe: linha sem paneId (pré-bind) sempre conta como viva', () => {
    const rows = [workerRow('a'), workerRow('b', 'pane-b')];
    const snapshots = [snapshot('pane-b', 'busy')];
    const result = countLiveMissionWorkerSlots(scope, MISSION, rows, snapshots);
    expect(result.live).toBe(2);
    expect(result.deadPaneIds).toEqual([]);
  });

  it('ignora linhas de orquestrador', () => {
    const rows = [
      { ...workerRow('orch', 'pane-o'), role: 'orchestrator' } as MissionPaneSpec,
      workerRow('a', 'pane-a'),
    ];
    const snapshots = [snapshot('pane-a', 'busy')];
    const result = countLiveMissionWorkerSlots(scope, MISSION, rows, snapshots);
    expect(result.live).toBe(1);
  });
});
