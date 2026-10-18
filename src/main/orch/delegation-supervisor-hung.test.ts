// @vitest-environment node
/**
 * F-242: scan real do supervisor — worker `working` há 20+ min sem ferramenta
 * nem saída, com o PTY parado, vira handoff `stalled` [travado] entregue ao
 * Maestro (`onHandoffSubmitted`). O restante do scan é mantido inerte por
 * configuração (orquestrador busy, missão não supervisionável, watchdogs
 * mockados em `none`).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mission } from '../../shared/orch-types';

const h = vi.hoisted(() => ({
  onScope: null as null | ((scope: unknown, suite: unknown) => void),
  listPaneSnapshots: vi.fn((): unknown[] => []),
  getSemantic: vi.fn(
    (_sessionId: string): { status: string; updatedAt: number } | null => null,
  ),
  onHandoffSubmitted: vi.fn(),
  redeliverPendingHandoffs: vi.fn(),
  submit: vi.fn(),
  blockTechnical: vi.fn(),
}));

vi.mock('./project-domain-store-registry', () => ({
  requireProjectDomainStoreRegistry: () => ({
    onScope: (cb: (scope: unknown, suite: unknown) => void) => {
      h.onScope = cb;
      return () => {};
    },
  }),
}));
vi.mock('./pane-registry', () => ({
  listPaneSnapshots: h.listPaneSnapshots,
  // F-723: o supervisor instala o tap de falha de início no prepare.
  tapPendingSpawnStartFailure: vi.fn(() => () => {}),
}));
vi.mock('./agent-status', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./agent-status')>()),
  getAgentSemanticStatusBySession: h.getSemantic,
}));
vi.mock('./idle-delivery', () => ({
  onHandoffSubmitted: h.onHandoffSubmitted,
  redeliverPendingHandoffs: h.redeliverPendingHandoffs,
  handoffDeliveryEligible: (handoff: { status?: string; fromAgent?: string }) =>
    handoff.fromAgent === 'nexus-delegation-supervisor' ||
    (handoff.status !== 'stalled' && handoff.fromAgent !== 'nexus-mission-driver'),
}));
vi.mock('./squad-store', () => ({ getSquad: vi.fn(() => null) }));
vi.mock('./mission-event-emit', () => ({
  emitChefIdleAwaitingWorkers: vi.fn(),
  emitMissionEvent: vi.fn(),
}));
vi.mock('./mission-intent-events', () => ({ emitMissionIntentEvent: vi.fn() }));
vi.mock('./mission-engine-registry', () => ({
  missionEngineForScope: () => ({ blockTechnical: h.blockTechnical }),
}));
vi.mock('./zero-delivery-watchdog', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./zero-delivery-watchdog')>()),
  decideZeroDeliveryWatchdog: vi.fn(() => ({ action: 'none' })),
}));
vi.mock('./mission-momentum-watchdog', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./mission-momentum-watchdog')>()),
  decideMomentumNudge: vi.fn(() => ({ action: 'none' })),
}));
vi.mock('./nexus-task-fail-closed-recovery', () => ({
  flushAllNexusTaskFailClosedRetries: vi.fn(),
}));
vi.mock('../observability/main-trace', () => ({ trace: vi.fn() }));

import {
  prepareDelegationSupervisor,
  reconcileDelegationSupervisor,
  shutdownDelegationSupervisor,
  WORKER_HUNG_AFTER_MS,
} from './delegation-supervisor';

const NOW = 100_000_000;

function runningMission(): Mission {
  return {
    id: 'mission-hung',
    title: 'Missão com worker travado',
    description: 'Falhas de suíte darwin-pty-supervisor',
    status: 'running',
    squadId: 'squad-1',
    milestones: [],
    learnings: '',
    createdAt: NOW - 60 * 60_000,
    updatedAt: NOW - 60 * 60_000,
    orchestratorSessionId: 'session-orch',
    // Contrato presente + intentState != 'legacy' + sem aprovação vigente →
    // não supervisionável: a recuperação automática fica quieta e só o
    // watchdog de worker travado pode produzir handoff.
    intentState: 'dispatched',
    intentVersion: 1,
    intentContract: { version: 1, lane: 'exec' },
  } as unknown as Mission;
}

const SCOPE = { projectId: 'p', checkoutId: 'c' };

function suite(mission: Mission) {
  return {
    scope: SCOPE,
    missions: { list: () => [mission], listIdsBatch: (after?: string) => after ? [] : [mission.id], get: () => mission, setStatus: vi.fn() },
    tasks: { list: () => [] },
    handoffs: {
      list: vi.fn(() => []),
      submit: h.submit.mockImplementation(
        (input: Record<string, unknown>) => ({
          id: `handoff-${h.submit.mock.calls.length}`,
          createdAt: NOW,
          delivered: false,
          deliveryState: 'queued',
          ...input,
        }),
      ),
      markSubmitted: vi.fn(() => true),
    },
  };
}

describe('F-242: worker travado no meio do turno acorda o Maestro', () => {
  it('returns the owned periodic reconciliation flight', async () => {
    const result = reconcileDelegationSupervisor(NOW);
    expect(result).toBeInstanceOf(Promise);
    await result;
  });
  beforeEach(async () => {
    vi.clearAllMocks();
    await shutdownDelegationSupervisor();
    prepareDelegationSupervisor();
  });

  it('scan do supervisor reavalia parques expirados no re-arm', async () => {
    const mission = runningMission();
    const stores = suite(mission);
    stores.handoffs.list.mockReturnValue([{
      id: 'handoff-parked',
      missionId: mission.id,
      sessionId: 'session-worker',
      fromAgent: 'worker-a',
      status: 'success',
      summary: 'entrega estacionada',
      delivered: false,
      deliveryState: 'queued',
      createdAt: NOW - 60 * 60_000,
    }] as never);
    h.onScope!(SCOPE, stores);
    h.listPaneSnapshots.mockReturnValue([
      { paneId: 'leader', sessionId: 'session-orch', kind: 'cli-agent', role: 'orchestrator', state: 'idle', missionId: mission.id },
    ]);
    h.getSemantic.mockReturnValue({ status: 'idle', updatedAt: NOW });

    await reconcileDelegationSupervisor(NOW);

    expect(h.redeliverPendingHandoffs).toHaveBeenCalledExactlyOnceWith(
      SCOPE,
      mission.id,
      undefined,
      { requeueExpiredParks: true },
    );
  });

  it('F-252: an hour awaiting workers warns the leader without revoking mission authority', async () => {
    const mission = runningMission();
    const stores = suite(mission);
    h.blockTechnical.mockImplementation(() => { mission.status = 'blocked'; });
    h.onScope!(SCOPE, stores);
    h.listPaneSnapshots.mockReturnValue([
      { paneId: 'leader', sessionId: 'session-orch', kind: 'cli-agent', role: 'orchestrator', state: 'idle', missionId: mission.id },
      { paneId: 'worker', sessionId: 'session-worker', kind: 'cli-agent', role: 'worker', state: 'idle', missionId: mission.id },
    ]);
    h.getSemantic.mockReturnValue({ status: 'idle', updatedAt: NOW - 1 });
    await reconcileDelegationSupervisor(NOW);
    await reconcileDelegationSupervisor(NOW + 60 * 60_000);
    expect(mission.status).toBe('running');
    expect(h.blockTechnical).not.toHaveBeenCalled();
    expect(h.submit).toHaveBeenCalledWith(expect.objectContaining({
      missionId: mission.id, status: 'stalled', summary: expect.stringContaining('[chef-idle:'),
    }));
    const count = h.submit.mock.calls.length;
    await reconcileDelegationSupervisor(NOW + 60 * 60_000 + 15_000);
    expect(h.submit).toHaveBeenCalledTimes(count);
  });

  it('working há 25 min + PTY idle → um handoff stalled [travado] entregue', async () => {
    const mission = runningMission();
    h.onScope!(SCOPE, suite(mission));
    h.listPaneSnapshots.mockReturnValue([
      {
        paneId: 'pane-orch',
        sessionId: 'session-orch',
        title: 'Maestro',
        kind: 'cli-agent',
        role: 'orchestrator',
        state: 'busy',
        missionId: mission.id,
      },
      {
        paneId: 'pty-muorc5mh-32',
        sessionId: 'session-worker',
        title: 'worker GLM',
        agentName: 'glm-32',
        kind: 'cli-agent',
        role: 'worker',
        state: 'idle',
        adapterId: 'glm',
        missionId: mission.id,
      },
    ] as never);
    h.getSemantic.mockImplementation((sessionId: string) =>
      sessionId === 'session-worker'
        ? { status: 'working', updatedAt: NOW - WORKER_HUNG_AFTER_MS - 5 * 60_000 }
        : { status: 'working', updatedAt: NOW - 10_000 },
    );

    await reconcileDelegationSupervisor(NOW);

    expect(h.submit).toHaveBeenCalledTimes(1);
    expect(h.submit).toHaveBeenCalledWith(
      expect.objectContaining({
        missionId: mission.id,
        status: 'stalled',
        fromAgent: 'nexus-delegation-supervisor',
        summary: expect.stringContaining('[travado]'),
      }),
    );
    expect(h.submit.mock.calls[0]![0].summary).toContain('pty-muorc5mh-32');
    expect(h.submit.mock.calls[0]![0].summary).toContain('nexus_pane_close');
    expect(h.onHandoffSubmitted).toHaveBeenCalledTimes(1);

    // Segundo scan 1 min depois: já notificado → nada novo.
    h.submit.mockClear();
    h.onHandoffSubmitted.mockClear();
    await reconcileDelegationSupervisor(NOW + 60_000);
    expect(h.submit).not.toHaveBeenCalled();
    expect(h.onHandoffSubmitted).not.toHaveBeenCalled();
  });

  it('worker com PTY busy não é travado → nenhum handoff', async () => {
    const mission = runningMission();
    h.onScope!(SCOPE, suite(mission));
    h.listPaneSnapshots.mockReturnValue([
      {
        paneId: 'pane-orch',
        sessionId: 'session-orch',
        title: 'Maestro',
        kind: 'cli-agent',
        role: 'orchestrator',
        state: 'busy',
        missionId: mission.id,
      },
      {
        paneId: 'pane-w',
        sessionId: 'session-worker',
        title: 'worker',
        kind: 'cli-agent',
        role: 'worker',
        state: 'busy',
        adapterId: 'glm',
        missionId: mission.id,
      },
    ] as never);
    h.getSemantic.mockImplementation((sessionId: string) =>
      sessionId === 'session-worker'
        ? { status: 'working', updatedAt: NOW - WORKER_HUNG_AFTER_MS - 5 * 60_000 }
        : { status: 'working', updatedAt: NOW - 10_000 },
    );

    await reconcileDelegationSupervisor(NOW);
    expect(h.submit).not.toHaveBeenCalled();
  });

  it('F-1380: worker sem hook de ferramenta com o PTY saindo não é travado; parado de verdade avisa com a última saída', async () => {
    // Campo 12/10: "[travado] Muse · s240-env … há 60 min (última atividade
    // 06:55)" e "devin … há 29 min (06:35)": as duas horas eram o nascimento
    // do pane. A tela seguia "◈ Thinking (5m 20s…)" e os dois entregaram. O
    // `working` semântico congela (tela só publica na transição; muse não tem
    // hook, devin não pulsa por ferramenta) e a varredura que caía entre dois
    // quadros do spinner via o PTY idle.
    const mission = runningMission();
    h.onScope!(SCOPE, suite(mission));
    const panes = (workerState: string) => [
      { paneId: 'pane-orch', sessionId: 'session-orch', title: 'Maestro', kind: 'cli-agent',
        role: 'orchestrator', state: 'busy', missionId: mission.id },
      { paneId: 'pane-mv52tnjk-2c', sessionId: 'session-muse', title: 'Muse · s240-env', kind: 'cli-agent',
        role: 'worker', state: workerState, adapterId: 'muse', missionId: mission.id },
    ];
    h.getSemantic.mockImplementation((sessionId: string) =>
      sessionId === 'session-muse'
        ? { status: 'working', updatedAt: NOW - 60 * 60_000 }
        : { status: 'working', updatedAt: NOW - 10_000 },
    );

    h.listPaneSnapshots.mockReturnValue(panes('busy') as never);
    await reconcileDelegationSupervisor(NOW);
    h.listPaneSnapshots.mockReturnValue(panes('idle') as never);
    await reconcileDelegationSupervisor(NOW + 15_000);
    expect(h.submit).not.toHaveBeenCalled();

    // 20 min sem saída desde a última vista: aí é travado, contado dela.
    await reconcileDelegationSupervisor(NOW + WORKER_HUNG_AFTER_MS + 1_000);
    expect(h.submit).toHaveBeenCalledTimes(1);
    expect(h.submit.mock.calls[0]![0].summary).toContain('há 20 min');
  });

  it('F-725: com dois projetos abertos o worker travado é avisado uma vez, não a cada varredura', async () => {
    // Campo 02/10: "[travado] worker DeepSeek … há 45/46 min" saiu a cada
    // 15 s. A limpeza do aviso usava as sessões vivas de UMA suite e apagava
    // o aviso da outra — o worker parecia novo em toda varredura.
    const mission = runningMission();
    h.onScope!(SCOPE, suite(mission));
    const otherScope = { projectId: 'p2', checkoutId: 'c2' };
    const otherSubmit = vi.fn();
    h.onScope!(otherScope, {
      scope: otherScope,
      missions: {
        list: () => [{ ...runningMission(), id: 'mission-outro-projeto', orchestratorSessionId: undefined }],
        listIdsBatch: (after?: string) => after ? [] : ['mission-outro-projeto'],
        get: () => ({ ...runningMission(), id: 'mission-outro-projeto', orchestratorSessionId: undefined }),
        setStatus: vi.fn(),
      },
      tasks: { list: () => [] },
      handoffs: { list: vi.fn(() => []), submit: otherSubmit, markSubmitted: vi.fn(() => true) },
    });
    h.listPaneSnapshots.mockReturnValue([
      {
        paneId: 'pane-orch',
        sessionId: 'session-orch',
        title: 'Maestro',
        kind: 'cli-agent',
        role: 'orchestrator',
        state: 'busy',
        missionId: mission.id,
      },
      {
        paneId: 'pane-deepseek',
        sessionId: 'session-worker',
        title: 'worker DeepSeek',
        kind: 'cli-agent',
        role: 'worker',
        state: 'idle',
        adapterId: 'deepseek',
        missionId: mission.id,
      },
    ] as never);
    h.getSemantic.mockImplementation((sessionId: string) =>
      sessionId === 'session-worker'
        ? { status: 'working', updatedAt: NOW - WORKER_HUNG_AFTER_MS - 25 * 60_000 }
        : { status: 'working', updatedAt: NOW - 10_000 },
    );

    await reconcileDelegationSupervisor(NOW);
    await reconcileDelegationSupervisor(NOW + 15_000);
    await reconcileDelegationSupervisor(NOW + 30_000);

    expect(h.submit).toHaveBeenCalledTimes(1);
    expect(h.submit.mock.calls[0]![0].summary).toContain('[travado]');
    expect(otherSubmit).not.toHaveBeenCalled();

    // A sessão saiu do inventário DA PRÓPRIA suite: o próximo episódio avisa.
    h.listPaneSnapshots.mockReturnValue([]);
    await reconcileDelegationSupervisor(NOW + 45_000);
    h.listPaneSnapshots.mockReturnValue([
      {
        paneId: 'pane-deepseek',
        sessionId: 'session-worker',
        title: 'worker DeepSeek',
        kind: 'cli-agent',
        role: 'worker',
        state: 'idle',
        adapterId: 'deepseek',
        missionId: mission.id,
      },
    ] as never);
    await reconcileDelegationSupervisor(NOW + 60_000);
    expect(h.submit).toHaveBeenCalledTimes(2);
  });
});
