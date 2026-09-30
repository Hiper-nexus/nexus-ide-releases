import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mission } from '../../shared/orch-types';
import type { ProjectDomainStoreSuite } from './project-domain-store-registry';
import { testProjectScope } from './__tests__/scope-fixture';

/**
 * Screenshot 2026-08-18: "Mission engine resume requires a technical block".
 *
 * O snapshot anuncia "Retomar" (allowedActions) para missão encerrada pelo
 * operador (blocked_user/runtime-closed) e para missão concluída com
 * trabalho residual (blocked_technical/residual-work de status done). O port
 * `resume` do motor só aceitava blocked_technical com dispatch block — os
 * DOIS estados em que a UI oferece o botão eram recusados com erro interno
 * em inglês. Reabrir tem que religar o runtime, não recusar.
 */

const harness = vi.hoisted(() => ({
  resumeFastLaneMission: vi.fn(async () => {}),
  taskList: [] as Array<{ id: string; title: string; status: string }>,
}));

vi.mock('../pty/pty-manager', () => ({
  getSessionState: () => null,
  getAgentSessionInfo: () => null,
  listAgentSessions: () => [],
}));

vi.mock('../acp/acp-harness-driver', () => ({
  getAcpDriverSession: () => null,
  listAcpDriverAgentSessions: () => [],
  getAcpDriverSemanticStatus: () => null,
}));

vi.mock('./agent-status', () => ({
  getAgentSemanticStatus: () => null,
  getAgentSemanticStatusBySession: () => null,
}));

vi.mock('./tool-util', () => ({
  assertSafePtyPrompt: () => {},
  deliverAgentPrompt: async () => true,
  withProjectContextBlocks: (options: { prompt?: string }) => options.prompt,
  withProjectContextBlocksAsync: async (options: { prompt?: string }) => options.prompt,
}));

vi.mock('./mission-event-emit', () => ({
  emitMissionEvent: () => {},
}));

vi.mock('./pane-registry', () => ({
  listPaneSnapshots: () => [],
  getPaneRuntimeAuthorityBySession: () => null,
  readSessionOutput: () => '',
}));

vi.mock('./squad-store', () => ({
  getSquad: () => null,
}));

vi.mock('./mission-fast-lane', () => ({
  fastLaneBootstrap: vi.fn(async () => {}),
  fastLaneOrchestratorPaneSummary: () => null,
  resumeFastLaneMission: harness.resumeFastLaneMission,
}));

vi.mock('./mission-engine-preparation', () => ({
  createMissionEnginePreparationPorts: () => ({
    arm: async () => {},
    compile: async () => { throw new Error('fora do escopo deste teste'); },
    persistReviewFence: () => {},
    discardUnfencedPreparation: () => {},
  }),
}));

const scope = testProjectScope();

let liveMission: Mission;
let transitionCount = 0;

function stores(): ProjectDomainStoreSuite {
  return {
    scope,
    missions: {
      get: () => liveMission,
      list: () => [liveMission],
      update: (_missionId: string, patch: Record<string, unknown>) => {
        liveMission = { ...liveMission, ...patch } as Mission;
        return liveMission;
      },
      transitionLifecycle: (
        _missionId: string,
        _expected: unknown,
        patch: Record<string, unknown>,
      ) => {
        transitionCount += 1;
        liveMission = { ...liveMission, ...patch } as Mission;
        return liveMission;
      },
      setOrchestratorSession: () => liveMission,
      hasCurrentKickoffAcceptance: () => false,
    },
    missionPanes: { list: () => [] },
    handoffs: { list: () => [] },
    taskDispatches: { list: () => [] },
    tasks: {
      list: () => harness.taskList,
      listPlannedTasks: () => [],
    },
  } as unknown as ProjectDomainStoreSuite;
}

vi.mock('./project-domain-store-registry', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('./project-domain-store-registry')>();
  return {
    ...actual,
    getProjectDomainStores: () => stores(),
  };
});

const RUNTIME_CLOSED_MARKER = '<!-- nexus:runtime-closed -->';

function baseMission(overrides: Partial<Mission>): Mission {
  return {
    id: 'mission-1',
    title: 'Prova',
    description: 'objetivo do operador',
    status: 'blocked',
    intentState: 'blocked_user',
    intentVersion: 3,
    createdAt: 1,
    updatedAt: 10,
    squadId: 'squad-1',
    milestones: [],
    ...overrides,
  } as Mission;
}

let engine: ReturnType<
  typeof import('./mission-engine-registry').missionEngineForScope
>;

beforeEach(async () => {
  vi.resetModules();
  harness.resumeFastLaneMission.mockClear();
  harness.taskList = [];
  transitionCount = 0;
  await import('./mission-engine-production');
  const { missionEngineForScope } = await import('./mission-engine-registry');
  engine = missionEngineForScope(scope);
});

describe('engine resume — os estados em que a UI oferece Retomar', () => {
  it('missão encerrada pelo operador reabre: limpa o selo, volta a executar e religa a Via Rápida', async () => {
    liveMission = baseMission({
      description:
        'objetivo do operador\n\n' +
        `${RUNTIME_CLOSED_MARKER}\n[NEXUS_RUNTIME_CLOSED] Execução encerrada pelo operador; histórico e receipts preservados.`,
    });

    await engine.command(scope, { kind: 'resume', missionId: 'mission-1' });

    expect(liveMission.status).toBe('running');
    expect(liveMission.intentState).toBe('executing');
    expect(liveMission.description).toBe('objetivo do operador');
    expect(harness.resumeFastLaneMission).toHaveBeenCalledTimes(1);
    expect(harness.resumeFastLaneMission).toHaveBeenCalledWith(
      scope,
      'mission-1',
    );
  });

  it('missão leftover parked reabre: limpa o selo e religa sem remontar sozinha no boot', async () => {
    liveMission = baseMission({
      description:
        'objetivo do operador\n\n' +
        '<!-- nexus:leftover-parked -->\n[NEXUS_LEFTOVER_PARKED] Missão leftover.',
    });

    await engine.command(scope, { kind: 'resume', missionId: 'mission-1' });

    expect(liveMission.status).toBe('running');
    expect(liveMission.intentState).toBe('executing');
    expect(liveMission.description).toBe('objetivo do operador');
    expect(harness.resumeFastLaneMission).toHaveBeenCalledTimes(1);
  });

  it('missão concluída com trabalho residual reabre para terminar o que falta', async () => {
    harness.taskList = [{ id: 'task-1', title: 'Falta isto', status: 'pending' }];
    liveMission = baseMission({
      status: 'done',
      intentState: 'done',
      result: undefined,
    });

    await engine.command(scope, { kind: 'resume', missionId: 'mission-1' });

    expect(liveMission.status).toBe('running');
    expect(liveMission.intentState).toBe('executing');
    expect(harness.resumeFastLaneMission).toHaveBeenCalledTimes(1);
  });

  it('missão concluída COM resultado reabre para o ajuste da revisão humana', async () => {
    // 0.68.4: o snapshot passou a anunciar `resume` em `completed` ("Pedir um
    // ajuste"), porque a entrega existe mas ainda não foi APROVADA — o
    // operador pode não aprovar. O invariante deste arquivo é o pareamento
    // "o que a UI anuncia, o motor aceita"; a versão anterior deste caso
    // existia só porque `completed` não anunciava nada.
    liveMission = baseMission({
      status: 'done',
      intentState: 'done',
      result: {
        outcome: 'success',
        summary: 'entrega verificada',
        evidenceIds: [],
        artifactRefs: [],
      },
    });

    await engine.command(scope, { kind: 'resume', missionId: 'mission-1' });

    expect(liveMission.status).toBe('running');
    expect(liveMission.intentState).toBe('executing');
    expect(liveMission.description).toMatch(
      /<!-- nexus:awaiting-adjustment:\d+ -->/,
    );
    // Reabrir precisa RELIGAR o runtime — é isso que devolve um coordenador
    // digitável para o operador pedir o ajuste.
    expect(harness.resumeFastLaneMission).toHaveBeenCalledTimes(1);
    expect(harness.resumeFastLaneMission).toHaveBeenCalledWith(
      scope,
      'mission-1',
      expect.objectContaining({ remountKind: 'operator' }),
    );
  });

  it('bloqueio técnico sem dispatch block continua recusado (regressão do caminho cerimonial)', async () => {
    liveMission = baseMission({
      status: 'blocked',
      intentState: 'blocked_technical',
      description: 'erro técnico qualquer sem marcador de despacho',
    });

    await expect(
      engine.command(scope, { kind: 'resume', missionId: 'mission-1' }),
    ).rejects.toThrow('mission engine resume requires an exact dispatch block');
    expect(harness.resumeFastLaneMission).not.toHaveBeenCalled();
  });
});
