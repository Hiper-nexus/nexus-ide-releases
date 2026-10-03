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
  submit: vi.fn(),
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
  redeliverPendingHandoffs: vi.fn(),
}));
vi.mock('./squad-store', () => ({ getSquad: vi.fn(() => null) }));
vi.mock('./mission-event-emit', () => ({
  emitChefIdleAwaitingWorkers: vi.fn(),
  emitMissionEvent: vi.fn(),
}));
vi.mock('./mission-intent-events', () => ({ emitMissionIntentEvent: vi.fn() }));
vi.mock('./mission-engine-registry', () => ({
  missionEngineForScope: () => ({ blockTechnical: vi.fn() }),
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
