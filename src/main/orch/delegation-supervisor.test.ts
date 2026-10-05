import { describe, expect, it } from 'vitest';
import type { Handoff, Mission } from '../../shared/orch-types';
import {
  CHEF_IDLE_BLOCK_AFTER_MS,
  chefIdleAgentActivity,
  DELEGATION_RETRY_MS,
  DELEGATION_SLA_MS,
  decideChefIdleEscalation,
  decideWorkerHung,
  delegationRecoveryStage,
  isDelegationSupervisable,
  pendingDeliverableHandoffs,
  shouldRearmHandoffDelivery,
  WORKER_HUNG_AFTER_MS,
  WORKER_HUNG_RENOTIFY_MS,
} from './delegation-supervisor';

const mission: Mission = {
  id: 'mission-a',
  title: 'Mission A',
  description: '',
  status: 'pending',
  squadId: 'squad-a',
  milestones: [],
  learnings: '',
  createdAt: 1_000,
  updatedAt: 1_000,
};

function recovery(createdAt: number, summary = 'recover'): Handoff {
  return {
    id: `handoff-${createdAt}`,
    missionId: mission.id,
    status: 'stalled',
    claimTrust: 'untrusted',
    summary,
    artifacts: [],
    evidenceIds: [],
    evidenceTrust: 'unverified',
    delivered: true,
    deliveryState: 'submitted',
    createdAt,
  };
}

/** Dispatched mission that should still be recoverable when empty after SLA. */
const dispatchedEmpty: Mission = {
  ...mission,
  status: 'running',
  description: 'Implementar login com OAuth',
  intentState: 'dispatched',
  intentVersion: 1,
  orchestratorSessionId: 'orch-session-1',
  intentContract: {
    version: 1,
    source: 'typed',
    goal: 'Implementar login com OAuth',
    acceptanceCriteria: ['Login funciona'],
    risk: 'sensitive',
    executionMode: 'assisted',
    contextPolicy: 'on-demand',
    intentVersion: 1,
    approvedAt: 1_000,
    dispatchedAt: 1_000,
    budgets: {
      planningTokens: 1200,
      executionTokens: 8000,
      maxWorkers: 2,
      maxSteps: 200,
    },
  },
};

describe('decideWorkerHung — worker travado no meio do turno (F-242)', () => {
  const now = 10_000_000;
  const working = {
    semanticStatus: 'working' as const,
    semanticUpdatedAt: now - WORKER_HUNG_AFTER_MS - 5 * 60_000, // 25 min
    paneState: 'idle' as const,
    notifiedAt: null,
    now,
  };

  it('working há 25 min com PTY parado → notify', () => {
    expect(decideWorkerHung(working)).toBe('notify');
  });

  it('working há menos de 20 min, PTY ocupado, ou sem updatedAt → none', () => {
    expect(
      decideWorkerHung({
        ...working,
        semanticUpdatedAt: now - 10 * 60_000,
      }),
    ).toBe('none');
    expect(decideWorkerHung({ ...working, paneState: 'busy' })).toBe('none');
    expect(decideWorkerHung({ ...working, paneState: 'spawning' })).toBe('none');
    expect(decideWorkerHung({ ...working, paneState: 'exited' })).toBe('none');
    expect(decideWorkerHung({ ...working, paneState: 'parked' })).toBe('none');
    expect(
      decideWorkerHung({ ...working, semanticUpdatedAt: undefined }),
    ).toBe('none');
  });

  it('já notificado: silêncio até 60 min, renotify depois', () => {
    expect(
      decideWorkerHung({ ...working, notifiedAt: now - 30 * 60_000 }),
    ).toBe('none');
    expect(
      decideWorkerHung({
        ...working,
        notifiedAt: now - WORKER_HUNG_RENOTIFY_MS - 60_000,
      }),
    ).toBe('renotify');
  });

  it('status que não é working → none', () => {
    for (const status of ['awaiting-input', 'idle', 'completed', undefined]) {
      expect(
        decideWorkerHung({ ...working, semanticStatus: status }),
      ).toBe('none');
    }
  });
});

describe('delegation supervisor policy', () => {
  it('chef idle aguardando workers: abaixo do teto só observa', () => {
    const t0 = 1_000_000;
    expect(
      decideChefIdleEscalation({
        idle: true,
        workerCount: 1,
        missionStatus: 'running',
        trackedSince: t0,
        trackedWorkerCount: 1,
        now: t0 + CHEF_IDLE_BLOCK_AFTER_MS - 1,
      }),
    ).toEqual({ action: 'watch' });
  });

  it('chef idle cruza o teto sem mudança de workers: bloqueia com motivo visível', () => {
    const t0 = 1_000_000;
    expect(
      decideChefIdleEscalation({
        idle: true,
        workerCount: 1,
        missionStatus: 'running',
        trackedSince: t0,
        trackedWorkerCount: 1,
        now: t0 + CHEF_IDLE_BLOCK_AFTER_MS,
      }),
    ).toEqual({ action: 'block', sinceMs: t0 });
  });

  it('mudança no número de workers reinicia o relógio (episódio novo)', () => {
    const t0 = 1_000_000;
    expect(
      decideChefIdleEscalation({
        idle: true,
        workerCount: 2,
        missionStatus: 'running',
        trackedSince: t0,
        trackedWorkerCount: 1,
        now: t0 + CHEF_IDLE_BLOCK_AFTER_MS + 5_000,
      }),
    ).toEqual({ action: 'reset' });
  });

  it('chef ocupado ou missão não-running zera o rastreamento', () => {
    expect(
      decideChefIdleEscalation({
        idle: false,
        workerCount: 1,
        missionStatus: 'running',
        trackedSince: 1_000,
        trackedWorkerCount: 1,
        now: 9_999_999,
      }),
    ).toEqual({ action: 'reset' });
    expect(
      decideChefIdleEscalation({
        idle: true,
        workerCount: 1,
        missionStatus: 'blocked',
        trackedSince: 1_000,
        trackedWorkerCount: 1,
        now: 9_999_999,
      }),
    ).toEqual({ action: 'reset' });
  });

  it('F-680: Maestro no meio de um comando longo não é chef ocioso (29/09 00:15)', () => {
    // Pane "idle" pela saída do terminal, mas o turno está aberto: o Maestro
    // esperava o ensaio no WSL num laço de sleep de até 10 min.
    const now = 10_000_000;
    const activity = chefIdleAgentActivity({
      orchestratorSessionId: 'pty-maestro',
      workers: [{ sessionId: 'pty-w1', state: 'idle' }, { sessionId: 'pty-w2', state: 'idle' }],
      now,
      semanticStatus: (id) => (id === 'pty-maestro' ? { status: 'working', updatedAt: now - 9 * 60_000 } : { status: 'idle', updatedAt: now - 40 * 60_000 }),
    });
    expect(activity).toEqual({ orchestratorInTurn: true, workerActive: false });
  });

  it('F-680: worker trabalhando é progresso — o relógio do bloqueio não corre (29/09 10:21)', () => {
    const now = 10_000_000;
    const busy = chefIdleAgentActivity({
      orchestratorSessionId: 'pty-maestro',
      workers: [{ sessionId: 'pty-codex', state: 'idle' }, { sessionId: 'pty-claude', state: 'busy' }],
      now,
      semanticStatus: () => ({ status: 'idle', updatedAt: now - 60_000 }),
    });
    expect(busy.workerActive).toBe(true);
    // Mesmo com o pane quieto, turno aberto recente conta como trabalho.
    const inTurn = chefIdleAgentActivity({
      orchestratorSessionId: 'pty-maestro',
      workers: [{ sessionId: 'pty-claude', state: 'idle' }],
      now,
      semanticStatus: (id) => (id === 'pty-claude' ? { status: 'working', updatedAt: now - 90_000 } : null),
    });
    expect(inTurn).toEqual({ orchestratorInTurn: false, workerActive: true });
  });

  it('F-680: missão parada de verdade (todos quietos, turno velho) continua escalando', () => {
    const now = 10_000_000;
    const stalled = chefIdleAgentActivity({
      orchestratorSessionId: 'pty-maestro',
      workers: [{ sessionId: 'pty-w1', state: 'idle' }],
      now,
      // "working" preso há mais que o teto do chef-idle não é trabalho.
      semanticStatus: () => ({ status: 'working', updatedAt: now - CHEF_IDLE_BLOCK_AFTER_MS - 1 }),
    });
    expect(stalled).toEqual({ orchestratorInTurn: false, workerActive: false });
  });

  it('primeira observação idle começa a contar, não bloqueia na hora', () => {
    expect(
      decideChefIdleEscalation({
        idle: true,
        workerCount: 1,
        missionStatus: 'running',
        trackedSince: null,
        trackedWorkerCount: 0,
        now: 5_000_000,
      }),
    ).toEqual({ action: 'watch' });
  });

  it('does NOT recover a squad mission that is only awaiting a goal (NavalhaGO case)', () => {
    const awaiting = {
      mission: {
        ...mission,
        status: 'pending' as const,
        intentState: 'awaiting_goal' as const,
      },
      expectedWorkers: 3,
      workerPanes: 0,
      tasks: 0,
      recoveries: [] as Handoff[],
      hasBoundOrchestrator: false,
    };
    expect(isDelegationSupervisable(awaiting)).toBe(false);
    expect(
      delegationRecoveryStage(awaiting, mission.createdAt + DELEGATION_SLA_MS * 10),
    ).toBe(0);
  });

  it('does not recover legacy running shells with zero goal, tasks, or workers', () => {
    // Pre-migration path: status=running was set on squad select without a goal.
    expect(
      delegationRecoveryStage(
        {
          mission: { ...mission, status: 'running', description: 'stale notes' },
          expectedWorkers: 3,
          workerPanes: 0,
          tasks: 0,
          recoveries: [],
          hasBoundOrchestrator: true,
        },
        mission.createdAt + DELEGATION_SLA_MS,
      ),
    ).toBe(0);
  });

  it('flags a dispatched mission that never creates a task or worker', () => {
    const dispatchAt = dispatchedEmpty.intentContract!.dispatchedAt!;
    expect(
      delegationRecoveryStage(
        {
          mission: dispatchedEmpty,
          expectedWorkers: 3,
          workerPanes: 0,
          tasks: 0,
          recoveries: [],
          hasBoundOrchestrator: true,
        },
        dispatchAt + DELEGATION_SLA_MS,
      ),
    ).toBe(1);
  });

  it('does not fire stage-1 immediately after long arm + fresh dispatch', () => {
    // Mission armed hours ago; dispatch authorized just now.
    const armedLongAgo: Mission = {
      ...dispatchedEmpty,
      createdAt: 1,
      updatedAt: 1,
      intentContract: {
        ...dispatchedEmpty.intentContract!,
        approvedAt: 1_000_000,
        dispatchedAt: 1_000_000,
      },
    };
    expect(
      delegationRecoveryStage(
        {
          mission: armedLongAgo,
          expectedWorkers: 3,
          workerPanes: 0,
          tasks: 0,
          recoveries: [],
          hasBoundOrchestrator: true,
        },
        1_000_000 + DELEGATION_SLA_MS - 1,
      ),
    ).toBe(0);
    expect(
      delegationRecoveryStage(
        {
          mission: armedLongAgo,
          expectedWorkers: 3,
          workerPanes: 0,
          tasks: 0,
          recoveries: [],
          hasBoundOrchestrator: true,
        },
        1_000_000 + DELEGATION_SLA_MS,
      ),
    ).toBe(1);
  });

  it('is not supervisable without a bound orchestrator', () => {
    expect(
      isDelegationSupervisable({
        mission: dispatchedEmpty,
        expectedWorkers: 3,
        workerPanes: 0,
        tasks: 0,
        recoveries: [],
        hasBoundOrchestrator: false,
      }),
    ).toBe(false);
  });

  it('stops observing as soon as real delegation progress exists', () => {
    expect(
      delegationRecoveryStage(
        {
          mission: dispatchedEmpty,
          expectedWorkers: 3,
          workerPanes: 0,
          tasks: 1,
          recoveries: [],
          hasBoundOrchestrator: true,
        },
        dispatchedEmpty.intentContract!.dispatchedAt! + DELEGATION_SLA_MS * 2,
      ),
    ).toBe(0);
  });

  it('does not call an orchestrator stalled while its terminal is working', () => {
    expect(
      delegationRecoveryStage(
        {
          mission: dispatchedEmpty,
          expectedWorkers: 3,
          workerPanes: 0,
          tasks: 0,
          recoveries: [],
          orchestratorState: 'busy',
          hasBoundOrchestrator: true,
        },
        dispatchedEmpty.intentContract!.dispatchedAt! + DELEGATION_SLA_MS * 10,
      ),
    ).toBe(0);
  });

  it('records two bounded recoveries without turning the technical stall into a block', () => {
    const dispatchAt = dispatchedEmpty.intentContract!.dispatchedAt!;
    const first = recovery(
      dispatchAt + DELEGATION_SLA_MS,
      `recover [recovery:${dispatchedEmpty.id}:stage_1]`,
    );
    const atRetry = first.createdAt + DELEGATION_RETRY_MS;
    const progress = {
      mission: dispatchedEmpty,
      expectedWorkers: 3,
      workerPanes: 0,
      tasks: 0,
      hasBoundOrchestrator: true as const,
    };
    expect(
      delegationRecoveryStage({ ...progress, recoveries: [first] }, atRetry),
    ).toBe(2);
    const second = recovery(
      atRetry,
      `final [recovery:${dispatchedEmpty.id}:stage_2]`,
    );
    expect(
      delegationRecoveryStage(
        {
          ...progress,
          recoveries: [first, second],
        },
        atRetry + DELEGATION_RETRY_MS * 10,
      ),
    ).toBe(0);
    expect(
      isDelegationSupervisable({
        ...progress,
        recoveries: [first, second],
      }),
    ).toBe(true);
  });

  it('does not reinterpret an operator-blocked mission as a technical recovery', () => {
    expect(
      isDelegationSupervisable({
        mission: { ...dispatchedEmpty, status: 'blocked' },
        expectedWorkers: 3,
        workerPanes: 0,
        tasks: 0,
        recoveries: [],
        hasBoundOrchestrator: true,
      }),
    ).toBe(false);
  });

  it('does not supervise consult-lane missions (read-only contract)', () => {
    expect(
      isDelegationSupervisable({
        mission: {
          ...dispatchedEmpty,
          intentContract: {
            ...dispatchedEmpty.intentContract!,
            lane: 'consult',
            budgets: {
              ...dispatchedEmpty.intentContract!.budgets,
              maxWorkers: 0,
            },
          },
        },
        expectedWorkers: 3,
        workerPanes: 0,
        tasks: 0,
        recoveries: [],
        hasBoundOrchestrator: true,
      }),
    ).toBe(false);
  });

  it('does not supervise plan-lane missions (design-only, no worker SLA)', () => {
    expect(
      isDelegationSupervisable({
        mission: {
          ...dispatchedEmpty,
          intentContract: {
            ...dispatchedEmpty.intentContract!,
            lane: 'plan',
            budgets: {
              ...dispatchedEmpty.intentContract!.budgets,
              maxWorkers: 0,
            },
          },
        },
        expectedWorkers: 3,
        workerPanes: 0,
        tasks: 0,
        recoveries: [],
        hasBoundOrchestrator: true,
      }),
    ).toBe(false);
  });

  it('does not interfere with squads that have no workers or terminal missions', () => {
    expect(
      delegationRecoveryStage(
        {
          mission: dispatchedEmpty,
          expectedWorkers: 0,
          workerPanes: 0,
          tasks: 0,
          recoveries: [],
          hasBoundOrchestrator: true,
        },
        Number.MAX_SAFE_INTEGER,
      ),
    ).toBe(0);
    expect(
      delegationRecoveryStage(
        {
          mission: { ...dispatchedEmpty, status: 'blocked' },
          expectedWorkers: 3,
          workerPanes: 0,
          tasks: 0,
          recoveries: [],
          hasBoundOrchestrator: true,
        },
        Number.MAX_SAFE_INTEGER,
      ),
    ).toBe(0);
  });

  it('ignores awaiting_approval and blocked_user forever', () => {
    for (const intentState of ['awaiting_approval', 'blocked_user'] as const) {
      expect(
        delegationRecoveryStage(
          {
            mission: {
              ...dispatchedEmpty,
              status: 'pending',
              intentState,
            },
            expectedWorkers: 5,
            workerPanes: 0,
            tasks: 0,
            recoveries: [],
            hasBoundOrchestrator: true,
          },
          Number.MAX_SAFE_INTEGER,
        ),
      ).toBe(0);
    }
  });
});

describe('shouldRearmHandoffDelivery — chef idle com pendente durável re-arma', () => {
  const base = {
    workerPaneCount: 1,
    orchestratorPaneState: 'idle' as string | undefined,
    missionStatus: 'running',
    missionAwaitingOperatorReview: false,
    pendingDeliverableHandoffs: 1,
    lastRearmAt: 0,
    now: 60_000,
  };

  it('chef idle + handoff não-entregue → re-armar (o caso do banco: queued, 0 tentativas)', () => {
    expect(shouldRearmHandoffDelivery(base)).toBe(true);
  });

  it('sem pendente, chef ocupado, missão terminal ou throttle ativo → não re-armar', () => {
    expect(shouldRearmHandoffDelivery({ ...base, pendingDeliverableHandoffs: 0 })).toBe(false);
    expect(shouldRearmHandoffDelivery({ ...base, orchestratorPaneState: 'busy' })).toBe(false);
    expect(shouldRearmHandoffDelivery({ ...base, orchestratorPaneState: undefined })).toBe(false);
    expect(shouldRearmHandoffDelivery({ ...base, missionStatus: 'blocked' })).toBe(false);
    expect(
      shouldRearmHandoffDelivery({ ...base, lastRearmAt: 30_000 }),
    ).toBe(false);
  });

  it('throttle libera de novo depois da janela', () => {
    expect(
      shouldRearmHandoffDelivery({ ...base, lastRearmAt: 0, now: 61_000 }),
    ).toBe(true);
  });

  it('F-112: done aguardando revisão do operador re-arma; done aprovado não', () => {
    // Fast lane marca done no mesmo segundo do handoff — entrega falhada
    // depois disso não pode ficar presa para sempre em queued.
    expect(
      shouldRearmHandoffDelivery({
        ...base,
        missionStatus: 'done',
        missionAwaitingOperatorReview: true,
      }),
    ).toBe(true);
    expect(
      shouldRearmHandoffDelivery({
        ...base,
        missionStatus: 'done',
        missionAwaitingOperatorReview: false,
      }),
    ).toBe(false);
  });

  it('F-113: chef em stale-busy re-arma handoff pendente', () => {
    expect(
      shouldRearmHandoffDelivery({
        ...base,
        orchestratorPaneState: 'busy',
        orchestratorStaleBusy: true,
      }),
    ).toBe(true);
    expect(
      shouldRearmHandoffDelivery({
        ...base,
        orchestratorPaneState: 'busy',
        orchestratorStaleBusy: false,
      }),
    ).toBe(false);
  });
});

describe('F-925: re-arm conta todo handoff entregável, não só success/blocked', () => {
  const queued = (overrides: Partial<Handoff>): Handoff => ({
    id: overrides.id ?? 'handoff-x',
    missionId: mission.id,
    claimTrust: 'untrusted',
    status: 'progress',
    summary: 'aviso pendente',
    artifacts: [],
    evidenceIds: [],
    evidenceTrust: 'unverified',
    delivered: false,
    deliveryState: 'queued',
    createdAt: 1,
    ...overrides,
  });

  it('progress de sistema e failed de worker morto re-armam com 0 workers vivos', () => {
    // Campo 05/10: o "Esteira parada" (progress, supervisor) e o sintético de
    // worker morto (failed, handoff-enforcement) ficaram queued 119 min sem
    // nunca re-armar — o filtro só contava success|blocked.
    expect(
      pendingDeliverableHandoffs([
        queued({
          id: 'h-momentum',
          status: 'progress',
          fromAgent: 'nexus-delegation-supervisor',
          summary: 'Esteira parada: nenhum worker há 20 min',
        }),
        queued({
          id: 'h-dead-worker',
          status: 'failed',
          fromAgent: 'nexus-handoff-enforcement',
          summary: 'worker saiu sem entregar',
        }),
        queued({
          id: 'h-hung',
          status: 'stalled',
          fromAgent: 'nexus-delegation-supervisor',
          summary: '[travado] worker pendurado (F-242)',
        }),
        queued({ id: 'h-partial', status: 'partial', fromAgent: 'worker-a' }),
      ]),
    ).toBe(4);
  });

  it('diagnóstico que nunca chega ao PTY não segura o re-arm', () => {
    // isDiagnosticDriverHandoff: stalled de worker e mission-driver são
    // ledger/UI — contá-los re-armaria uma fila que nunca desce.
    expect(
      pendingDeliverableHandoffs([
        queued({ id: 'h1', status: 'stalled', fromAgent: 'worker-a' }),
        queued({ id: 'h2', status: 'progress', fromAgent: 'nexus-mission-driver' }),
        queued({ id: 'h3', status: 'stalled', fromAgent: 'nexus-mission-driver' }),
      ]),
    ).toBe(0);
  });
});
