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
  orchestratorDismissed: false,
  rendererCurrent: true,
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
  wasOrchestratorOperatorDismissed: () => harness.orchestratorDismissed,
}));

vi.mock('./squad-store', () => ({
  getSquad: () => null,
}));

vi.mock('../persistence/renderer-workspace-scope', () => ({ requireRendererWorkspaceScope: () => scope, requireLiveRendererWorkspaceScope: () => { if (!harness.rendererCurrent) throw new Error('workspace changed'); return scope; } }));

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
  harness.orchestratorDismissed = false;
  harness.rendererCurrent = true;
  transitionCount = 0;
  await import('./mission-engine-production');
  const { missionEngineForScope } = await import('./mission-engine-registry');
  engine = missionEngineForScope(scope);
});

describe('engine resume — os estados em que a UI oferece Retomar', () => {
  it('F-254: running/executing with a dead coordinator still reaches physical recovery', async () => {
    liveMission = baseMission({ status: 'running', intentState: 'executing', orchestratorSessionId: 'dead-session' });
    await engine.command(scope, { kind: 'resume', missionId: 'mission-1' });
    expect(harness.resumeFastLaneMission).toHaveBeenCalledWith(scope, 'mission-1', { remountKind: 'operator' });
    expect(transitionCount).toBe(0);
  });

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

  it('F-245: bloqueio técnico sem marcador de dispatch (chef-idle) reabre via remount do operador', async () => {
    // O bloqueio do chef-idle não tem marcador de despacho — o resume antigo
    // lançava "requires an exact dispatch block" e a missão não tinha saída.
    liveMission = baseMission({
      status: 'blocked',
      intentState: 'blocked_technical',
      description:
        'objetivo\n\n[NEXUS_CHEF_IDLE] Orquestrador ocioso aguardando ' +
        '1 worker(s) por 60min sem progresso.',
    });

    await engine.command(scope, { kind: 'resume', missionId: 'mission-1' });

    expect(harness.resumeFastLaneMission).toHaveBeenCalledTimes(1);
    expect(harness.resumeFastLaneMission).toHaveBeenCalledWith(
      scope,
      'mission-1',
      expect.objectContaining({
        remountKind: 'operator',
        note: expect.stringContaining('bloqueio técnico'),
      }),
    );
  });

  it('F-738: bloqueio declarado pelo Maestro, sem pergunta registrada, reabre via remount do operador', async () => {
    // set_status blocked não registra pergunta e o reconciliador encerra o
    // Maestro. O card anuncia "Retomar o coordenador"; o motor recusava com
    // "requires a technical block" e a missão ficava sem saída.
    liveMission = baseMission({
      status: 'blocked',
      intentState: 'blocked_user',
      description:
        'objetivo\n\n<!-- nexus:agent-status-block -->\n' +
        '[NEXUS_AGENT_STATUS_BLOCK] O orquestrador declarou status=blocked: ' +
        'pergunta de escopo sem resposta.',
    });

    await engine.command(scope, { kind: 'resume', missionId: 'mission-1' });

    expect(harness.resumeFastLaneMission).toHaveBeenCalledTimes(1);
    expect(harness.resumeFastLaneMission).toHaveBeenCalledWith(
      scope,
      'mission-1',
      expect.objectContaining({
        remountKind: 'operator',
        note: expect.stringContaining('bloqueado esperando'),
      }),
    );
  });

  it('F-738: selo velho de encerramento antes do bloqueio do Maestro não vira "encerrada pelo operador"', async () => {
    // Caso de campo 02/10: o selo sobreviveu à retomada das 09:14 e o Maestro
    // bloqueou às 10:01. O Retomar seguia o caminho de reabrir o selo.
    liveMission = baseMission({
      status: 'blocked',
      intentState: 'blocked_user',
      description:
        'objetivo\n\n' +
        `${RUNTIME_CLOSED_MARKER}\n[NEXUS_RUNTIME_CLOSED] Execução encerrada pelo operador; histórico e receipts preservados.\n\n` +
        '<!-- nexus:agent-status-block -->\n' +
        '[NEXUS_AGENT_STATUS_BLOCK] O orquestrador declarou status=blocked: pedido original irrecuperável.',
    });

    await engine.command(scope, { kind: 'resume', missionId: 'mission-1' });

    expect(harness.resumeFastLaneMission).toHaveBeenCalledWith(
      scope,
      'mission-1',
      expect.objectContaining({ remountKind: 'operator' }),
    );
  });

  it('F-245: retry-kickoff com coordenador dispensado falha visível, nunca em silêncio', async () => {
    liveMission = baseMission({
      status: 'blocked',
      intentState: 'blocked_technical',
    });
    harness.orchestratorDismissed = true;

    await expect(
      engine.command(scope, { kind: 'retry-kickoff', missionId: 'mission-1' }),
    ).rejects.toThrow('orchestrator_operator_dismissed');
    expect(harness.resumeFastLaneMission).not.toHaveBeenCalled();
  });

  it('F-245: retry-kickoff sem pane dispensado segue o remount automático', async () => {
    liveMission = baseMission({
      status: 'blocked',
      intentState: 'blocked_technical',
    });

    await engine.command(scope, {
      kind: 'retry-kickoff',
      missionId: 'mission-1',
    });

    expect(harness.resumeFastLaneMission).toHaveBeenCalledWith(
      scope,
      'mission-1',
      expect.objectContaining({ remountKind: 'automatic' }),
    );
  });
});


it.each(['bootstrap', 'resume', 'retry-kickoff'] as const)('F-429: %s waits for the same physical stop lock', async lane => {
  liveMission = baseMission({});
  const { withMissionLifecycleLock } = await import('./mission-lifecycle-lock');
  const { resumeBlockedMissionBootstrapFromRenderer } = await import('./mission-engine-production');
  let finishStop!: () => void;
  const stopExit = new Promise<void>(resolve => { finishStop = resolve; });
  const stopping = withMissionLifecycleLock(scope, 'mission-1', () => stopExit);
  await Promise.resolve();
  const resume = lane === 'bootstrap' ? resumeBlockedMissionBootstrapFromRenderer({} as never, { missionId: 'mission-1' }) : engine.command(scope, { kind: lane, missionId: 'mission-1' });
  void resume.catch(() => {});
  try {
    await Promise.resolve(); await Promise.resolve();
    expect(harness.resumeFastLaneMission).not.toHaveBeenCalled();
  } finally {
    liveMission = baseMission({ description: '<!-- nexus:runtime-closed -->\n[NEXUS_RUNTIME_CLOSED] Encerrada.' });
    finishStop();
  }
  await stopping;
  if (lane === 'retry-kickoff') { await expect(resume).rejects.toThrow(/encerrada pelo operador/); expect(harness.resumeFastLaneMission).not.toHaveBeenCalled(); }
  else { await resume; expect(harness.resumeFastLaneMission).toHaveBeenCalledOnce(); }
});


it('F-429: queued human resume revalidates renderer scope after Stop releases', async () => {
  liveMission = baseMission({});
  const { withMissionLifecycleLock } = await import('./mission-lifecycle-lock');
  const { resumeBlockedMissionBootstrapFromRenderer } = await import('./mission-engine-production');
  let finish!: () => void;
  const held = withMissionLifecycleLock(scope, 'mission-1', () => new Promise<void>(resolve => { finish = resolve; }));
  await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
  const resume = resumeBlockedMissionBootstrapFromRenderer({} as never, { missionId: 'mission-1' });
  harness.rendererCurrent = false; finish(); await held;
  await expect(resume).resolves.toMatchObject({ ok: false, error: 'workspace changed' });
  expect(harness.resumeFastLaneMission).not.toHaveBeenCalled();
});


it.each(['resume', 'retry-kickoff'] as const)('F-429: legacy running Stop row distinguishes explicit %s from recovery', async kind => {
  const description = '<!-- nexus:runtime-closed -->\n[NEXUS_RUNTIME_CLOSED] Encerrada.\n\n<!-- nexus:leftover-parked -->\n[NEXUS_LEFTOVER_PARKED] Dormindo.';
  liveMission = baseMission({ status: 'running', intentState: 'executing', description });
  if (kind === 'retry-kickoff') {
    await expect(engine.command(scope, { kind, missionId: 'mission-1' })).rejects.toThrow(/encerrada pelo operador/);
    expect(harness.resumeFastLaneMission).not.toHaveBeenCalled(); expect(liveMission.description).toBe(description);
  } else {
    await engine.command(scope, { kind, missionId: 'mission-1' });
    expect(liveMission.description).not.toContain('runtime-closed');
    expect(liveMission.description).not.toContain('leftover-parked');
    expect(harness.resumeFastLaneMission).toHaveBeenCalledOnce();
  }
});
