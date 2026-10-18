// @vitest-environment node
/**
 * Reinício não pode desligar os dedups do supervisor: zeroDeliveryPoked,
 * zeroDeliveryEscalated e momentumReadySince viviam só em memória — depois de
 * um boot, o poke/escalada de zero-entrega se repetia e o nudge ready perdia
 * a referência do relógio. Aqui o ledger já traz a escalada e o nudge ready
 * ENTREGUES antes do restart; uma instância nova (shutdown+prepare) com
 * workers quietos não pode repetir nenhuma cobrança nos primeiros minutos.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Handoff, Mission } from '../../shared/orch-types';
import { momentumReadyBacklog } from './mission-momentum-watchdog';

const h = vi.hoisted(() => ({
  onScope: null as null | ((scope: unknown, suite: unknown) => void),
  listPaneSnapshots: vi.fn((): unknown[] => []),
  getSemantic: vi.fn(
    (_sessionId: string): { status: string; updatedAt: number } | null => null,
  ),
  toolActivity: vi.fn((_sessionId: string) => 0),
  onHandoffSubmitted: vi.fn(),
  judge: vi.fn(async () => ({ kind: 'skipped' })),
  getSessionState: vi.fn(
    (sessionId: string) =>
      (sessionId === 'session-orch' || sessionId.startsWith('session-worker')
        ? 'idle'
        : null) as string | null,
  ),
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
  tapPendingSpawnStartFailure: vi.fn(() => () => {}),
}));
vi.mock('../pty/pty-manager', () => ({
  getSessionState: h.getSessionState,
  tapSessionTermination: () => () => {},
  getAgentSessionInfo: () => null,
  getRequestedTerminationOrigin: () => null,
  getSessionSpawnedAtMs: () => null,
}));
vi.mock('./agent-status', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./agent-status')>()),
  getAgentSemanticStatusBySession: h.getSemantic,
  getAgentToolActivityCount: h.toolActivity,
}));
vi.mock('./idle-delivery', () => ({
  onHandoffSubmitted: h.onHandoffSubmitted,
  redeliverPendingHandoffs: vi.fn(() => 0),
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
vi.mock('./jev-mission-momentum', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./jev-mission-momentum')>()),
  judgeMissionMomentum: h.judge,
}));
vi.mock('./nexus-task-fail-closed-recovery', () => ({
  flushAllNexusTaskFailClosedRetries: vi.fn(),
}));
vi.mock('../observability/main-trace', () => ({ trace: vi.fn() }));

import {
  DELEGATION_SUPERVISOR_AGENT,
  prepareDelegationSupervisor,
  reconcileDelegationSupervisor,
  shutdownDelegationSupervisor,
} from './delegation-supervisor';

const NOW = 200_000_000;
const MIN = 60_000;
const MISSION_ID = 'mission-estudo';
const SCOPE = { projectId: 'p', checkoutId: 'c' };

function supervisorHandoff(createdAt: number, summary: string): Handoff {
  return {
    id: `handoff-${createdAt}`,
    missionId: MISSION_ID,
    status: 'stalled',
    fromAgent: DELEGATION_SUPERVISOR_AGENT,
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

function mission(): Mission {
  return {
    id: MISSION_ID,
    title: 'Estudo de repositório grande',
    description: 'Workers somente leitura parados há horas',
    status: 'running',
    squadId: 'squad-1',
    milestones: [],
    learnings: '',
    createdAt: NOW - 6 * 60 * MIN,
    updatedAt: NOW - 60 * MIN,
    orchestratorSessionId: 'session-orch',
    intentState: 'dispatched',
    intentVersion: 1,
    intentContract: { version: 1, lane: 'standard', dispatchedAt: NOW - 4 * 60 * MIN },
  } as unknown as Mission;
}

const READY_TASK = {
  id: 'task-ready-1',
  missionId: MISSION_ID,
  title: 'Independent ready work',
  detail: '',
  status: 'pending',
  createdAt: NOW - 90 * MIN,
  updatedAt: NOW - 90 * MIN,
};

function suite(row: Mission) {
  return {
    scope: SCOPE,
    missions: {
      list: () => [row],
      listIdsBatch: (after?: string) => (after ? [] : [row.id]),
      get: () => row,
      setStatus: vi.fn(),
    },
    tasks: {
      list: () => [READY_TASK],
      getPlanReceipt: () => ({
        intentVersion: 1,
        tasks: [{ taskId: 'task-ready-1', plannerId: 'planner-1', detail: '' }],
      }),
    },
    taskDispatches: { list: () => [] },
    missionPanes: { list: () => [] },
    handoffs: {
      list: vi.fn((): Handoff[] => ledger),
      submit: h.submit.mockImplementation((input: Record<string, unknown>) => ({
        id: `new-${h.submit.mock.calls.length}`,
        createdAt: NOW,
        delivered: false,
        deliveryState: 'queued',
        ...input,
      })),
      markSubmitted: vi.fn(() => true),
    },
  };
}

/** Escalada e nudge ready ENTREGUES antes do restart (ledger durável). */
const ESCALATED_AT = NOW - 80 * MIN;
const READY_NUDGED_AT = NOW - 10 * MIN;
let ledger: Handoff[] = [];

function seededLedger(): Handoff[] {
  const backlogKey = momentumReadyBacklog({
    tasks: [READY_TASK],
    sealedTasks: [{ taskId: 'task-ready-1', plannerId: 'planner-1', detail: '' }],
    dispatches: [],
    intentVersion: 1,
  }).backlogKey;
  return [
    supervisorHandoff(
      ESCALATED_AT,
      `[zero-delivery-escalate:${MISSION_ID}] Zero entrega e workers sem atividade há 70min.`,
    ),
    supervisorHandoff(
      READY_NUDGED_AT,
      `[momentum:${MISSION_ID}] [momentum-ready:${backlogKey}] Há 1 tarefas registradas prontas e 1 vagas do orçamento da missão.`,
    ),
  ];
}

function panes(row: Mission) {
  return [
    {
      paneId: 'pane-orch',
      sessionId: 'session-orch',
      title: 'Maestro',
      kind: 'cli-agent',
      role: 'orchestrator',
      state: 'idle',
      missionId: row.id,
    },
    ...Array.from({ length: 2 }, (_, index) => ({
      paneId: `pane-worker-${index}`,
      sessionId: `session-worker-${index}`,
      title: `worker ${index}`,
      kind: 'cli-agent',
      role: 'worker',
      state: 'idle',
      readOnly: true,
      adapterId: 'claude',
      missionId: row.id,
    })),
  ];
}

describe('reinício semeia dedups do supervisor a partir do ledger', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    h.getSemantic.mockReturnValue(null);
    h.toolActivity.mockReturnValue(0);
    ledger = seededLedger();
    await shutdownDelegationSupervisor();
    prepareDelegationSupervisor();
  });

  it('escalada entregue + restart + workers quietos: nem escalada nem nudge ready de novo', async () => {
    const row = mission();
    const stores = suite(row);
    h.onScope!(SCOPE, stores);
    h.listPaneSnapshots.mockReturnValue(panes(row));
    // Restart já aconteceu (beforeEach zera os mapas); primeiros minutos.
    for (const minutes of [0, 0.5, 1, 2, 3, 5, 8]) {
      await reconcileDelegationSupervisor(NOW + minutes * MIN);
    }
    const submitted = h.submit.mock.calls.map(
      (call) => String((call[0] as { summary?: unknown }).summary ?? ''),
    );
    expect(submitted.filter((s) => s.includes('[zero-delivery'))).toEqual([]);
    expect(submitted.filter((s) => s.startsWith(`[momentum:${MISSION_ID}]`))).toEqual([]);
  });

  it('sem o seed do ledger a mesma missão repete a cobrança (prova do mecanismo)', async () => {
    // Ledger SEM a escalada: mesmo cenário de workers quietos deve cobrar.
    ledger = [
      supervisorHandoff(
        READY_NUDGED_AT,
        `[momentum:${MISSION_ID}] Esteira parada: a missão está sem nenhum worker há 10 min.`,
      ),
    ];
    const row = mission();
    const stores = suite(row);
    h.onScope!(SCOPE, stores);
    h.listPaneSnapshots.mockReturnValue(panes(row));
    await reconcileDelegationSupervisor(NOW + 0 * MIN);
    await reconcileDelegationSupervisor(NOW + 15 * MIN);
    const submitted = h.submit.mock.calls.map(
      (call) => String((call[0] as { summary?: unknown }).summary ?? ''),
    );
    expect(submitted.filter((s) => s.includes('[zero-delivery'))).not.toEqual([]);
  });
});
