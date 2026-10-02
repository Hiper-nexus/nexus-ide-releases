// @vitest-environment node
/**
 * F-723: o supervisor confere se o pane que o Nexus soltou começou a tarefa.
 * Fiação real do watchdog de início (taps, varredura, efeitos), com o resto
 * do scan inerte como no F-242: missão não supervisionável, watchdogs
 * mockados em `none`. Campo 02/10: o Qwen aberto pelo Maestro morreu no spawn
 * e ficou parado — ninguém soube, nada foi reenviado.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mission } from '../../shared/orch-types';
import { testProjectScope } from './__tests__/scope-fixture';

const h = vi.hoisted(() => ({
  onScope: null as null | ((scope: unknown, suite: unknown) => void),
  listPaneSnapshots: vi.fn((): unknown[] => []),
  pendingSession: vi.fn(
    (_requestId: string):
      | { state: 'waiting' }
      | { state: 'bound'; sessionId: string }
      | { state: 'gone' } => ({ state: 'waiting' }),
  ),
  requestPaneClose: vi.fn(async (_paneId: string, _sessionId?: string) => true),
  abandon: vi.fn((_requestId: string, _reason: string) => true),
  startFailureTap: null as null | ((failure: Record<string, unknown>) => void),
  terminationTap: null as
    | null
    | ((sessionId: string, agent: Record<string, unknown> | null) => void),
  sessionState: vi.fn((_sessionId: string): string | null => null),
  spawnedAt: vi.fn((_sessionId: string): number | null => null),
  terminationOrigin: vi.fn((_sessionId: string): string | null => null),
  turnStart: vi.fn((_sessionId: string) => 0),
  getSemantic: vi.fn(
    (_sessionId: string): { status: string; updatedAt: number } | null => null,
  ),
  onHandoffSubmitted: vi.fn(),
  submit: vi.fn(),
  markSubmitted: vi.fn(() => true),
  handoffList: vi.fn((_filter?: unknown): unknown[] => []),
  injectPrompt: vi.fn(async (_sessionId: string, _text: string) => {}),
  trace: vi.fn(),
}));

vi.mock('./project-domain-store-registry', () => ({
  requireProjectDomainStoreRegistry: () => ({
    onScope: (cb: (scope: unknown, suite: unknown) => void) => {
      h.onScope = cb;
      return () => {};
    },
  }),
  getProjectDomainStores: () => {
    throw new Error('suite deveria vir do onScope');
  },
}));
vi.mock('./pane-registry', () => ({
  listPaneSnapshots: h.listPaneSnapshots,
  pendingSpawnAttemptSession: h.pendingSession,
  requestPaneClose: h.requestPaneClose,
  abandonPendingOrchSpawn: h.abandon,
  tapPendingSpawnStartFailure: (cb: (failure: Record<string, unknown>) => void) => {
    h.startFailureTap = cb;
    return () => {
      h.startFailureTap = null;
    };
  },
}));
vi.mock('../pty/pty-manager', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../pty/pty-manager')>()),
  getSessionState: h.sessionState,
  getSessionSpawnedAtMs: h.spawnedAt,
  getRequestedTerminationOrigin: h.terminationOrigin,
  tapSessionTermination: (
    cb: (sessionId: string, agent: Record<string, unknown> | null) => void,
  ) => {
    h.terminationTap = cb;
    return () => {
      h.terminationTap = null;
    };
  },
}));
vi.mock('./agent-status', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./agent-status')>()),
  getAgentSemanticStatusBySession: h.getSemantic,
  getAgentTurnStartSequence: h.turnStart,
}));
vi.mock('./idle-delivery', () => ({
  onHandoffSubmitted: h.onHandoffSubmitted,
  redeliverPendingHandoffs: vi.fn(),
}));
vi.mock('./tool-util', () => ({ injectPrompt: h.injectPrompt }));
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
vi.mock('../observability/main-trace', () => ({ trace: h.trace }));

import {
  checkPaneStarts,
  prepareDelegationSupervisor,
  reconcileDelegationSupervisor,
  shutdownDelegationSupervisor,
} from './delegation-supervisor';
import {
  START_GRACE_MS,
  getPaneStartWatch,
  resetPaneStartWatchdogForTests,
  trackPaneStart,
  type PaneStartWatchInit,
} from './pane-start-watchdog';
import { adapterCircuitBreakers } from './circuit-breaker';
import { WORKSPACE_HANDOFF_DELIVERY_PREFIX } from './workspace-handoff-delivery';

const NOW = 200_000_000;
const SCOPE = testProjectScope();

function mission(): Mission {
  return {
    id: 'mission-f723',
    title: 'Missão com worker que não subiu',
    description: '',
    status: 'running',
    squadId: 'squad-1',
    milestones: [],
    learnings: '',
    createdAt: NOW - 60 * 60_000,
    updatedAt: NOW - 60 * 60_000,
    orchestratorSessionId: 'session-maestro',
    // Contrato sem aprovação vigente: a recuperação de delegação fica quieta.
    intentState: 'dispatched',
    intentVersion: 1,
    intentContract: { version: 1, lane: 'exec' },
  } as unknown as Mission;
}

function registerSuite(): void {
  h.onScope!(SCOPE, {
    scope: SCOPE,
    missions: { list: () => [mission()], setStatus: vi.fn() },
    tasks: { list: () => [] },
    handoffs: {
      list: h.handoffList,
      submit: h.submit.mockImplementation((input: Record<string, unknown>) => ({
        id: `handoff-${h.submit.mock.calls.length}`,
        createdAt: NOW,
        delivered: false,
        deliveryState: 'queued',
        ...input,
      })),
      markSubmitted: h.markSubmitted,
    },
  });
}

const reroute = vi.fn(async (_exclude: readonly string[]) => ({
  paneId: 'pane-novo',
  adapterId: 'codex',
}));
const redeliver = vi.fn(async () => false);

function watchInit(overrides: Partial<PaneStartWatchInit> = {}): PaneStartWatchInit {
  return {
    paneId: 'pane-qwen',
    requestId: 'orchspawn-qwen',
    adapterId: 'qwen',
    scope: SCOPE,
    missionId: 'mission-f723',
    role: 'worker',
    callerSessionId: 'session-maestro',
    turnProof: false,
    pinnedRuntime: false,
    rerouted: false,
    createdAt: NOW - 5_000,
    redeliver,
    reroute,
    hasAlternative: () => true,
    ...overrides,
  };
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
};

describe('F-723: pane que não começou a tarefa é corrigido ou mandado para outro', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.pendingSession.mockReturnValue({ state: 'waiting' });
    h.sessionState.mockReturnValue(null);
    h.spawnedAt.mockReturnValue(null);
    h.terminationOrigin.mockReturnValue(null);
    h.turnStart.mockReturnValue(0);
    h.getSemantic.mockReturnValue(null);
    h.handoffList.mockReturnValue([]);
    h.listPaneSnapshots.mockReturnValue([]);
    reroute.mockResolvedValue({ paneId: 'pane-novo', adapterId: 'codex' });
    redeliver.mockResolvedValue(false);
    adapterCircuitBreakers.reset();
    resetPaneStartWatchdogForTests();
    shutdownDelegationSupervisor();
    prepareDelegationSupervisor();
    registerSuite();
  });
  afterEach(() => {
    vi.useRealTimers();
    shutdownDelegationSupervisor();
    resetPaneStartWatchdogForTests();
  });

  it('PTY recusado depois do ACK pendente: reroteia na hora, conta no disjuntor e avisa o Maestro', async () => {
    vi.useFakeTimers({ now: NOW, toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    trackPaneStart(watchInit());
    h.listPaneSnapshots.mockReturnValue([
      { paneId: 'pane-qwen', kind: 'cli-agent', role: 'worker', state: 'exited', missionId: 'mission-f723' },
    ]);
    // O pane-registry liquidou a tentativa (pty-ipc devolveu ok:false).
    h.pendingSession.mockReturnValue({ state: 'gone' });
    h.startFailureTap!({
      requestId: 'orchspawn-qwen',
      paneId: 'pane-qwen',
      adapterId: 'qwen',
      missionId: 'mission-f723',
      error: 'Qwen Code: modelo selado "qwen3.7-plus" não entrou no argv do spawn',
    });
    // Falha provada não espera a varredura de 15 s.
    await vi.advanceTimersByTimeAsync(0);
    await flush();

    expect(reroute).toHaveBeenCalledTimes(1);
    expect(reroute).toHaveBeenCalledWith(['qwen']);
    expect(redeliver).not.toHaveBeenCalled();
    expect(h.abandon).toHaveBeenCalledWith('orchspawn-qwen', expect.any(String));
    expect(h.requestPaneClose).toHaveBeenCalledWith('pane-qwen', undefined);
    expect(adapterCircuitBreakers.snapshot('qwen').recentFailures).toBe(1);
    expect(h.submit).toHaveBeenCalledTimes(1);
    const handoff = h.submit.mock.calls[0]![0] as Record<string, string>;
    expect(handoff).toMatchObject({
      missionId: 'mission-f723',
      status: 'progress',
      fromAgent: 'nexus-delegation-supervisor',
    });
    expect(handoff.summary).toBe(
      '[nao-iniciou:pane-qwen] O pane pane-qwen (qwen) não começou a tarefa: ' +
        'o CLI não subiu (o spawn foi recusado). Reenviada para codex (pane pane-novo).',
    );
    // Nunca o texto do erro bruto, argv ou brief no aviso.
    expect(handoff.summary).not.toContain('modelo selado');
    expect(h.onHandoffSubmitted).toHaveBeenCalledTimes(1);
    expect(h.trace).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'pane-not-started',
        paneId: 'pane-qwen',
        cause: 'spawn-refused',
        outcome: 'rerouted',
        nextAdapterId: 'codex',
      }),
    );
    expect(getPaneStartWatch('pane-qwen')).toBeNull();

    // Nada se repete nas varreduras seguintes.
    reconcileDelegationSupervisor(NOW + 60_000);
    await flush();
    expect(reroute).toHaveBeenCalledTimes(1);
    expect(h.submit).toHaveBeenCalledTimes(1);
  });

  it('sessão viva sem turno (família Claude): reenvia o brief uma vez e, ainda parado, manda para outro', async () => {
    trackPaneStart(watchInit({
      paneId: 'pane-claude',
      requestId: 'orchspawn-claude',
      adapterId: 'claude',
      turnProof: true,
    }));
    h.pendingSession.mockReturnValue({ state: 'bound', sessionId: 'session-claude' });
    h.spawnedAt.mockReturnValue(NOW - START_GRACE_MS - 1_000);
    h.sessionState.mockReturnValue('idle');
    h.listPaneSnapshots.mockReturnValue([
      { paneId: 'pane-claude', sessionId: 'session-claude', kind: 'cli-agent', role: 'worker', state: 'idle', missionId: 'mission-f723' },
    ]);

    await checkPaneStarts(NOW);
    expect(redeliver).toHaveBeenCalledTimes(1);
    expect(reroute).not.toHaveBeenCalled();
    expect(h.submit).not.toHaveBeenCalled();

    // Dentro da nova graça: espera, não reenvia de novo.
    await checkPaneStarts(NOW + 30_000);
    expect(redeliver).toHaveBeenCalledTimes(1);
    expect(reroute).not.toHaveBeenCalled();

    await checkPaneStarts(NOW + START_GRACE_MS);
    expect(redeliver).toHaveBeenCalledTimes(1);
    expect(reroute).toHaveBeenCalledWith(['claude']);
    expect(h.abandon).not.toHaveBeenCalled();
    expect(h.requestPaneClose).toHaveBeenCalledWith('pane-claude', 'session-claude');
    expect(String((h.submit.mock.calls[0]![0] as { summary: string }).summary)).toContain(
      'mesmo com o briefing reenviado',
    );
  });

  it('reenvio aceito: o pane começou e a falha anterior do adapter é zerada', async () => {
    adapterCircuitBreakers.recordFailure('claude');
    trackPaneStart(watchInit({ adapterId: 'claude', turnProof: true }));
    h.pendingSession.mockReturnValue({ state: 'bound', sessionId: 'session-claude' });
    h.spawnedAt.mockReturnValue(NOW - START_GRACE_MS - 1_000);
    h.sessionState.mockReturnValue('idle');
    redeliver.mockResolvedValue(true);

    await checkPaneStarts(NOW);
    expect(redeliver).toHaveBeenCalledTimes(1);
    await checkPaneStarts(NOW + 15_000);
    expect(getPaneStartWatch('pane-qwen')).toBeNull();
    expect(adapterCircuitBreakers.snapshot('claude').recentFailures).toBe(0);
    expect(reroute).not.toHaveBeenCalled();
    expect(h.submit).not.toHaveBeenCalled();
  });

  it('turno aberto: nada a fazer', async () => {
    trackPaneStart(watchInit({ turnProof: true }));
    h.pendingSession.mockReturnValue({ state: 'bound', sessionId: 'session-w' });
    h.spawnedAt.mockReturnValue(NOW - 10 * 60_000);
    h.sessionState.mockReturnValue('idle');
    h.turnStart.mockReturnValue(1);

    await checkPaneStarts(NOW);
    expect(redeliver).not.toHaveBeenCalled();
    expect(reroute).not.toHaveBeenCalled();
    expect(getPaneStartWatch('pane-qwen')).toBeNull();
  });

  it('nenhuma sessão nasceu na graça: revoga a tentativa e manda para outro', async () => {
    trackPaneStart(watchInit({ createdAt: NOW - START_GRACE_MS }));
    await checkPaneStarts(NOW);
    expect(h.abandon).toHaveBeenCalledWith('orchspawn-qwen', expect.any(String));
    expect(reroute).toHaveBeenCalledWith(['qwen']);
    expect(String((h.submit.mock.calls[0]![0] as { summary: string }).summary)).toContain(
      'nenhuma sessão nasceu em 90 s',
    );
  });

  it('processo que saiu sozinho no boot (tap de terminação) não começou', async () => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
    trackPaneStart(watchInit({ adapterId: 'codex' }));
    h.spawnedAt.mockReturnValue(NOW - 3_000);
    h.terminationTap!('session-codex', { paneId: 'pane-qwen', adapterId: 'codex' });
    h.pendingSession.mockReturnValue({ state: 'bound', sessionId: 'session-codex' });

    await checkPaneStarts(NOW);
    expect(reroute).toHaveBeenCalledWith(['codex']);
    expect(String((h.submit.mock.calls[0]![0] as { summary: string }).summary)).toContain(
      'o processo saiu antes de abrir o primeiro turno',
    );
  });

  it('pane fechado de propósito (encerramento pedido) não é falha de início', async () => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
    trackPaneStart(watchInit({ adapterId: 'codex' }));
    h.spawnedAt.mockReturnValue(NOW - 3_000);
    h.terminationOrigin.mockReturnValue('pane-close');
    h.terminationTap!('session-codex', { paneId: 'pane-qwen', adapterId: 'codex' });

    await checkPaneStarts(NOW);
    expect(reroute).not.toHaveBeenCalled();
    expect(h.submit).not.toHaveBeenCalled();
    expect(getPaneStartWatch('pane-qwen')).toBeNull();
  });

  it('tentativa liquidada sem falha de CLI (chamador revogado) larga a ficha em silêncio', async () => {
    trackPaneStart(watchInit());
    h.pendingSession.mockReturnValue({ state: 'gone' });
    await checkPaneStarts(NOW);
    expect(reroute).not.toHaveBeenCalled();
    expect(h.submit).not.toHaveBeenCalled();
    expect(adapterCircuitBreakers.snapshot('qwen').recentFailures).toBe(0);
  });

  it('helper do operador sem outra CLI: não reroteia e avisa o pane pai pela entrega sem missão', async () => {
    trackPaneStart(watchInit({
      missionId: undefined,
      role: 'helper',
      callerSessionId: 'session-operador',
      hasAlternative: () => false,
    }));
    h.pendingSession.mockReturnValue({ state: 'gone' });
    h.sessionState.mockImplementation((sessionId) =>
      sessionId === 'session-operador' ? 'idle' : null,
    );
    h.startFailureTap!({ requestId: 'orchspawn-qwen', paneId: 'pane-qwen', error: 'x' });
    await checkPaneStarts(NOW);
    await flush();

    expect(reroute).not.toHaveBeenCalled();
    expect(adapterCircuitBreakers.snapshot('qwen').recentFailures).toBe(1);
    const handoff = h.submit.mock.calls[0]![0] as Record<string, string>;
    expect(handoff.missionId).toBeUndefined();
    expect(handoff.summary).toContain('Nenhuma outra CLI está disponível — decida.');
    expect(h.onHandoffSubmitted).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(h.markSubmitted).toHaveBeenCalledWith('handoff-1'));
    expect(h.injectPrompt).toHaveBeenCalledWith(
      'session-operador',
      expect.stringMatching(
        new RegExp(`^\\${WORKSPACE_HANDOFF_DELIVERY_PREFIX.slice(0, -1)}\\] de pane-qwen`),
      ),
    );
  });

  it('pane aberto pelo operador (F-231): nunca fecha, reenvia nem conta no disjuntor', async () => {
    trackPaneStart(watchInit({ operatorOpened: true }));
    h.startFailureTap!({ requestId: 'orchspawn-qwen', paneId: 'pane-qwen', error: 'x' });
    await checkPaneStarts(NOW);
    expect(h.requestPaneClose).not.toHaveBeenCalled();
    expect(reroute).not.toHaveBeenCalled();
    expect(adapterCircuitBreakers.snapshot('qwen').recentFailures).toBe(0);
    expect(String((h.submit.mock.calls[0]![0] as { summary: string }).summary)).toContain(
      'O pane é do operador e continua aberto',
    );
  });

  it('a tentativa que já era o reenvio e também não sobe só avisa (sem laço)', async () => {
    trackPaneStart(watchInit({ rerouted: true }));
    h.startFailureTap!({ requestId: 'orchspawn-qwen', paneId: 'pane-qwen', error: 'x' });
    await checkPaneStarts(NOW);
    expect(reroute).not.toHaveBeenCalled();
    expect(String((h.submit.mock.calls[0]![0] as { summary: string }).summary)).toContain(
      'Esta já era a tentativa reenviada',
    );
  });

  it('reenvio que falha na rota vira aviso para o Maestro decidir', async () => {
    reroute.mockRejectedValueOnce(
      new Error('mission_worker_route_unavailable: nenhuma CLI elegível'),
    );
    trackPaneStart(watchInit());
    h.startFailureTap!({ requestId: 'orchspawn-qwen', paneId: 'pane-qwen', error: 'x' });
    await checkPaneStarts(NOW);
    const summary = String((h.submit.mock.calls[0]![0] as { summary: string }).summary);
    expect(summary).toContain('O reenvio automático falhou (mission_worker_route_unavailable');
    expect(summary).toContain('decida');
  });
});
