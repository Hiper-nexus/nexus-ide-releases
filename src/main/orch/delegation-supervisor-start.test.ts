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
    | ((
        sessionId: string,
        agent: Record<string, unknown> | null,
        rootExit?: { exitCode: number; signal?: number } | null,
      ) => void),
  sessionState: vi.fn((_sessionId: string): string | null => null),
  sessionOutput: vi.fn((_sessionId: string, _lines?: number) => ''),
  spawnedAt: vi.fn((_sessionId: string): number | null => null),
  terminationOrigin: vi.fn((_sessionId: string): string | null => null),
  turnStart: vi.fn((_sessionId: string) => 0),
  getSemantic: vi.fn(
    (_sessionId: string): { status: string; updatedAt: number } | null => null,
  ),
  // F-734: fatos de turno sem conteúdo e o tap de fim de turno.
  toolActivity: vi.fn((_sessionId: string) => 0),
  lastTurnEnd: vi.fn((_sessionId: string): Record<string, unknown> | null => null),
  turnEndTap: null as null | ((entry: Record<string, unknown>) => void),
  agentInfo: vi.fn((_sessionId: string): Record<string, unknown> | null => null),
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
  readSessionOutput: h.sessionOutput,
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
  getAgentSessionInfo: h.agentInfo,
  getSessionState: h.sessionState,
  getSessionSpawnedAtMs: h.spawnedAt,
  getRequestedTerminationOrigin: h.terminationOrigin,
  tapSessionTermination: (
    cb: (
      sessionId: string,
      agent: Record<string, unknown> | null,
      rootExit?: { exitCode: number; signal?: number } | null,
    ) => void,
  ) => {
    h.terminationTap = cb;
    return () => {
      h.terminationTap = null;
    };
  },
}));
vi.mock('../pty/pty-analysis-runtime', async (original) => {
  const actual = await original<typeof import('../pty/pty-analysis-runtime')>();
  const { detectLimit } = await import('./limit-detector');
  const { listPaneStartWatches } = await import('./pane-start-watchdog');
  return {
    ...actual,
    isPtyAnalysisEnabled: () => false,
    getPtyAnalysisLimitEvidence: (sessionId: string) => {
      const watch = listPaneStartWatches().find((entry) => entry.sessionId === sessionId);
      return watch ? { status: 'accepted', binding: { paneId: watch.paneId, adapterId: watch.adapterId }, hit: detectLimit(h.sessionOutput(sessionId, 80)) } : { status: 'unavailable' };
    },
  };
});
vi.mock('./agent-status', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./agent-status')>()),
  getAgentSemanticStatusBySession: h.getSemantic,
  getAgentTurnStartSequence: h.turnStart,
  getAgentToolActivityCount: h.toolActivity,
  getAgentLastTurnEnd: h.lastTurnEnd,
  tapAgentTurnEnd: (cb: (entry: Record<string, unknown>) => void) => {
    h.turnEndTap = cb;
    return () => {
      h.turnEndTap = null;
    };
  },
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
  MODEL_REJECTION_HANDOFF_MS,
  START_GRACE_MS,
  getPaneStartWatch,
  notePaneStartAccepted,
  releasePaneStartWatch,
  resetPaneStartWatchdogForTests,
  trackPaneStart,
  type PaneStartWatchInit,
} from './pane-start-watchdog';
import { adapterCircuitBreakers } from './circuit-breaker';
import { WORKSPACE_HANDOFF_DELIVERY_PREFIX } from './workspace-handoff-delivery';
import {
  recordPaneSessionData,
  readSessionOutput as readRealSessionOutput,
  __evictExitedBufferForTests,
} from './pane-session-output';

const NOW = 200_000_000;
const SCOPE = testProjectScope();
/** Tela real do Codex 0.146 com conta ChatGPT (03/10), célula quebrada pela TUI. */
const CODEX_REJECTION_SCREEN = [
  '■ {"type":"error","status":400,"error":',
  '{"type":"invalid_request_error","message":"The \'gpt-6.1-sol\' model is not',
  'supported when using Codex with a ChatGPT account."}}',
].join('\n');

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
    missions: { list: () => [mission()], get: () => mission(), setStatus: vi.fn() },
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
  beforeEach(async () => {
    vi.clearAllMocks();
    h.pendingSession.mockReturnValue({ state: 'waiting' });
    h.sessionState.mockReturnValue(null);
    h.spawnedAt.mockReturnValue(null);
    h.terminationOrigin.mockReturnValue(null);
    h.turnStart.mockReturnValue(0);
    h.getSemantic.mockReturnValue(null);
    h.toolActivity.mockReturnValue(0);
    h.lastTurnEnd.mockReturnValue(null);
    h.sessionOutput.mockImplementation((sessionId: string, lines?: number) =>
      readRealSessionOutput(sessionId, lines),
    );
    h.agentInfo.mockReturnValue(null);
    h.handoffList.mockReturnValue([]);
    h.listPaneSnapshots.mockReturnValue([]);
    reroute.mockResolvedValue({ paneId: 'pane-novo', adapterId: 'codex' });
    redeliver.mockResolvedValue(false);
    adapterCircuitBreakers.reset();
    resetPaneStartWatchdogForTests();
    await shutdownDelegationSupervisor();
    prepareDelegationSupervisor();
    registerSuite();
  });
  afterEach(async () => {
    vi.useRealTimers();
    await shutdownDelegationSupervisor();
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
    await reconcileDelegationSupervisor(NOW + 60_000);
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

  it('reenvio aceito: o turno abriu; quando ele trabalha, o pane começou e a falha anterior do adapter é zerada', async () => {
    adapterCircuitBreakers.recordFailure('claude');
    trackPaneStart(watchInit({ adapterId: 'claude', turnProof: true }));
    h.pendingSession.mockReturnValue({ state: 'bound', sessionId: 'session-claude' });
    h.spawnedAt.mockReturnValue(NOW - START_GRACE_MS - 1_000);
    h.sessionState.mockReturnValue('idle');
    redeliver.mockResolvedValue(true);

    await checkPaneStarts(NOW);
    expect(redeliver).toHaveBeenCalledTimes(1);
    // F-734: turno aceito na família Claude ainda não é início — espera o
    // desfecho dele, sem reenviar de novo nem rerotear.
    await checkPaneStarts(NOW + START_GRACE_MS + 15_000);
    expect(getPaneStartWatch('pane-qwen')).not.toBeNull();
    expect(redeliver).toHaveBeenCalledTimes(1);
    expect(adapterCircuitBreakers.snapshot('claude').recentFailures).toBe(1);

    h.toolActivity.mockReturnValue(1);
    await checkPaneStarts(NOW + START_GRACE_MS + 30_000);
    expect(getPaneStartWatch('pane-qwen')).toBeNull();
    expect(adapterCircuitBreakers.snapshot('claude').recentFailures).toBe(0);
    expect(reroute).not.toHaveBeenCalled();
    expect(h.submit).not.toHaveBeenCalled();
  });

  it('CLI sem prova de turno: o turno aberto assenta e vira início (F-723/F-765)', async () => {
    trackPaneStart(watchInit({ turnProof: false }));
    h.pendingSession.mockReturnValue({ state: 'bound', sessionId: 'session-w' });
    h.spawnedAt.mockReturnValue(NOW - 10 * 60_000);
    h.sessionState.mockReturnValue('idle');
    h.turnStart.mockReturnValue(1);

    await checkPaneStarts(NOW);
    // Assentando: só espera a primeira resposta do provedor.
    expect(getPaneStartWatch('pane-qwen')).not.toBeNull();
    await checkPaneStarts(NOW + 15_000);
    expect(getPaneStartWatch('pane-qwen')).toBeNull();
    expect(redeliver).not.toHaveBeenCalled();
    expect(reroute).not.toHaveBeenCalled();
  });

  it.each(['agy', 'mimo-code', 'muse'])(
    'F-765: %s sem telemetria (sem ferramenta, sem fim de turno) e ocioso não recebe reenvio nem reroteamento',
    async (adapterId) => {
      // A CLI manda um ou dois eventos por sessão: nenhum de ferramenta nem de
      // fim de turno. Ela trabalha calada no worktree e o PTY fica ocioso.
      adapterCircuitBreakers.recordFailure(adapterId);
      const watch = trackPaneStart(watchInit({ adapterId, turnProof: false }));
      notePaneStartAccepted('pane-qwen', NOW - 1_000);
      h.pendingSession.mockReturnValue({ state: 'bound', sessionId: 'session-w' });
      h.spawnedAt.mockReturnValue(NOW - START_GRACE_MS - 60_000);
      h.sessionState.mockReturnValue('idle');

      await checkPaneStarts(NOW);
      expect(getPaneStartWatch('pane-qwen')).toBe(watch);
      await checkPaneStarts(NOW + 15_000);
      // Muito depois da graça de 90 s, ainda ocioso: nada de "siga" fantasma.
      await checkPaneStarts(NOW + START_GRACE_MS + 60_000);

      expect(getPaneStartWatch('pane-qwen')).toBeNull();
      expect(redeliver).not.toHaveBeenCalled();
      expect(reroute).not.toHaveBeenCalled();
      expect(h.requestPaneClose).not.toHaveBeenCalled();
      expect(h.submit).not.toHaveBeenCalled();
      // O início foi provado como no F-723: a falha antiga do adapter zera.
      expect(adapterCircuitBreakers.snapshot(adapterId).recentFailures).toBe(0);
    },
  );

  it('F-765: Codex com prompt aceito e erro permanente nunca registra sucesso nem dispara outro motor', async () => {
    const watch = trackPaneStart(watchInit({ adapterId: 'codex', turnProof: false }));
    watch.accepted = true;
    h.pendingSession.mockReturnValue({ state: 'bound', sessionId: 'session-codex' });
    h.spawnedAt.mockReturnValue(NOW - 5_000);
    h.sessionState.mockReturnValue('idle');
    h.turnStart.mockReturnValue(1);
    const recordSuccess = vi.spyOn(adapterCircuitBreakers, 'recordSuccess');

    await checkPaneStarts(NOW);
    expect(getPaneStartWatch('pane-qwen')).toBe(watch);
    h.sessionOutput.mockReturnValue(CODEX_REJECTION_SCREEN);
    h.lastTurnEnd.mockReturnValue({ outcome: 'error' });
    h.turnEndTap!({
      sessionId: 'session-codex', paneId: 'pane-qwen', outcome: 'error',
      worked: false, observedAt: NOW + 10_000,
    });
    expect(watch.failure).toBeNull();
    expect(watch.turnOutcome).toBeNull();
    await checkPaneStarts(NOW + 15_000);

    expect(recordSuccess).not.toHaveBeenCalled();
    expect(getPaneStartWatch('pane-qwen')).toBe(watch);
    expect(redeliver).not.toHaveBeenCalled();
    expect(reroute).not.toHaveBeenCalled();
    expect(h.requestPaneClose).not.toHaveBeenCalled();
    recordSuccess.mockRestore();
  });

  it('F-765: recusa de modelo que o failover não assumiu no prazo vira falha e segue o F-723', async () => {
    trackPaneStart(watchInit({ adapterId: 'codex', turnProof: false }));
    notePaneStartAccepted('pane-qwen', NOW - 2_000);
    h.pendingSession.mockReturnValue({ state: 'bound', sessionId: 'session-codex' });
    h.spawnedAt.mockReturnValue(NOW - 5_000);
    h.sessionState.mockReturnValue('idle');
    h.sessionOutput.mockReturnValue(CODEX_REJECTION_SCREEN);
    h.listPaneSnapshots.mockReturnValue([
      { paneId: 'pane-qwen', sessionId: 'session-codex', kind: 'cli-agent', role: 'worker', state: 'idle', missionId: 'mission-f723' },
    ]);

    await checkPaneStarts(NOW);
    await checkPaneStarts(NOW + MODEL_REJECTION_HANDOFF_MS - 1);
    expect(reroute).not.toHaveBeenCalled();

    await checkPaneStarts(NOW + MODEL_REJECTION_HANDOFF_MS);
    expect(reroute).toHaveBeenCalledWith(['codex']);
    expect(h.requestPaneClose).toHaveBeenCalledWith('pane-qwen', 'session-codex');
    expect(String((h.submit.mock.calls[0]![0] as { summary: string }).summary)).toContain(
      'pedido recusado pelo provedor',
    );
  });

  it('F-765: a recusa citada no pane de OUTRA CLI não segura a ficha', async () => {
    trackPaneStart(watchInit({ adapterId: 'kimi', turnProof: false }));
    notePaneStartAccepted('pane-qwen', NOW - 20_000);
    h.pendingSession.mockReturnValue({ state: 'bound', sessionId: 'session-kimi' });
    h.sessionState.mockReturnValue('idle');
    h.sessionOutput.mockReturnValue(CODEX_REJECTION_SCREEN);

    await checkPaneStarts(NOW);
    expect(getPaneStartWatch('pane-qwen')).toBeNull();
    expect(reroute).not.toHaveBeenCalled();
  });

  it('F-765: depois que o failover assume o pane, a ficha não age mais', async () => {
    trackPaneStart(watchInit({ adapterId: 'codex', turnProof: false }));
    notePaneStartAccepted('pane-qwen', NOW - 2_000);
    h.pendingSession.mockReturnValue({ state: 'bound', sessionId: 'session-codex' });
    h.sessionState.mockReturnValue('idle');
    h.sessionOutput.mockReturnValue(CODEX_REJECTION_SCREEN);

    await checkPaneStarts(NOW);
    expect(releasePaneStartWatch('pane-qwen')).toBe(true);
    await checkPaneStarts(NOW + MODEL_REJECTION_HANDOFF_MS + 15_000);
    expect(reroute).not.toHaveBeenCalled();
    expect(h.submit).not.toHaveBeenCalled();
  });

  it('família Claude: turno aberto sem trabalho espera o desfecho; Stop normal prova o início (F-734)', async () => {
    trackPaneStart(watchInit({ adapterId: 'claude', turnProof: true }));
    h.pendingSession.mockReturnValue({ state: 'bound', sessionId: 'session-w' });
    h.spawnedAt.mockReturnValue(NOW - 10 * 60_000);
    h.sessionState.mockReturnValue('idle');
    h.turnStart.mockReturnValue(1);

    await checkPaneStarts(NOW);
    expect(redeliver).not.toHaveBeenCalled();
    expect(reroute).not.toHaveBeenCalled();
    expect(getPaneStartWatch('pane-qwen')).not.toBeNull();

    h.lastTurnEnd.mockReturnValue({ outcome: 'completed', worked: false });
    await checkPaneStarts(NOW + 15_000);
    expect(getPaneStartWatch('pane-qwen')).toBeNull();
    expect(reroute).not.toHaveBeenCalled();
    expect(h.submit).not.toHaveBeenCalled();
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

  it('persiste a cauda sanitizada de um boot-exit, mesmo depois de fechar e rerotear o pane', async () => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
    trackPaneStart(watchInit());
    h.spawnedAt.mockReturnValue(NOW - 3_000);
    recordPaneSessionData('session-boot-diagnostic', [
      ...Array.from({ length: 55 }, (_, index) => `boot line ${index}`),
      '\u001b[31mError: unrecognized argument --example\u001b[0m',
      'api_key=opaque-secret-value',
      'sessionFingerprint=opaque-fingerprint-value',
      'eyJabcdefghijk.abcdefghijklm.nopqrstuvwxyz',
    ].join('\n'));
    h.terminationTap!('session-boot-diagnostic', { paneId: 'pane-qwen', adapterId: 'qwen' });
    h.requestPaneClose.mockImplementationOnce(async () => {
      __evictExitedBufferForTests('session-boot-diagnostic');
      return true;
    });

    await checkPaneStarts(NOW);
    const event = h.trace.mock.calls.map(([value]) => value).find(
      (value) => value.kind === 'pane-not-started',
    );
    expect(event).toMatchObject({ cause: 'boot-exit', outputTail: expect.any(String) });
    expect(event.outputTail).toContain('Error: unrecognized argument --example');
    expect(event.outputTail).toContain('boot line 20');
    expect(event.outputTail).not.toContain('boot line 0\n');
    expect(event.outputTail).not.toMatch(/opaque-secret|opaque-fingerprint|eyJabcdefgh|\u001b/);
    expect(event.outputTail.split('\n').length).toBeLessThanOrEqual(41);
    expect(event.outputTail.length).toBeLessThanOrEqual(8192);
    expect(JSON.stringify(h.submit.mock.calls)).not.toContain('--example');
  });

  it('F-792: agy one-shot que saiu com código 1 em 4 s (caso do F-773) vira pane-not-started e é reroteado', async () => {
    vi.useFakeTimers({ now: NOW, toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    trackPaneStart(watchInit({ paneId: 'pane-agy', requestId: 'orchspawn-agy', adapterId: 'agy' }));
    h.spawnedAt.mockReturnValue(NOW - 4_276);
    recordPaneSessionData(
      'session-agy',
      'E1003 printmode.go:304] Print mode: invalid model selection (--model "gemini-4-argon" ' +
        '--effort "high"): --effort is not supported for model "gemini-4-argon"\r\n',
    );
    // Exit natural (sem pedido do Nexus): o tap chega com a saída da raiz.
    h.terminationTap!(
      'session-agy',
      { paneId: 'pane-agy', adapterId: 'agy', oneShot: true },
      { exitCode: 1, signal: 0 },
    );
    // Falha provada não espera a varredura de 15 s.
    await vi.advanceTimersByTimeAsync(0);
    await flush();

    expect(reroute).toHaveBeenCalledWith(['agy']);
    expect(adapterCircuitBreakers.snapshot('agy').recentFailures).toBe(1);
    const event = h.trace.mock.calls.map(([value]) => value).find(
      (value) => value.kind === 'pane-not-started',
    );
    expect(event).toMatchObject({
      paneId: 'pane-agy',
      adapterId: 'agy',
      cause: 'boot-exit',
      outcome: 'rerouted',
      nextAdapterId: 'codex',
    });
    expect(event.outputTail).toContain('--effort is not supported for model');
    const summary = (h.submit.mock.calls[0]![0] as { summary: string }).summary;
    expect(summary).toContain('o processo saiu antes de abrir o primeiro turno');
    expect(getPaneStartWatch('pane-agy')).toBeNull();
  });

  it('F-792: one-shot que terminou com código 0 continua sem veredito (a tarefa acabou)', async () => {
    vi.useFakeTimers({ now: NOW, toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    trackPaneStart(watchInit({ paneId: 'pane-agy', requestId: 'orchspawn-agy', adapterId: 'agy' }));
    h.spawnedAt.mockReturnValue(NOW - 30_000);
    h.terminationTap!(
      'session-agy',
      { paneId: 'pane-agy', adapterId: 'agy', oneShot: true },
      { exitCode: 0, signal: 0 },
    );
    await vi.advanceTimersByTimeAsync(0);
    await checkPaneStarts(NOW);

    expect(reroute).not.toHaveBeenCalled();
    expect(h.submit).not.toHaveBeenCalled();
    expect(getPaneStartWatch('pane-agy')).toBeNull();
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
      undefined,
      'supervisor',
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

/**
 * F-734 (campo 02/10): o worker DeepSeek recebeu o brief (UserPromptSubmit),
 * toda chamada de API voltou 401 ("Retrying in 3s · attempt 8/10") e o turno
 * acabou em StopFailure `authentication_failed`. O F-723 contava o turno
 * aberto como "começou": ninguém reroteou e o Maestro nunca soube.
 */
describe('F-734: turno do brief recusado pelo provedor é falha de início', () => {
  const PROVIDER_TEXT = 'Your api key: ****WXYZ is invalid';

  beforeEach(async () => {
    vi.clearAllMocks();
    h.pendingSession.mockReturnValue({ state: 'bound', sessionId: 'session-ds' });
    h.sessionState.mockReturnValue('idle');
    h.spawnedAt.mockReturnValue(NOW - 60_000);
    h.terminationOrigin.mockReturnValue(null);
    // UserPromptSubmit chegou: o turno do brief abriu.
    h.turnStart.mockReturnValue(1);
    h.getSemantic.mockReturnValue({ status: 'working', updatedAt: NOW - 50_000 });
    h.toolActivity.mockReturnValue(0);
    h.lastTurnEnd.mockReturnValue(null);
    h.sessionOutput.mockImplementation((sessionId: string, lines?: number) =>
      readRealSessionOutput(sessionId, lines),
    );
    h.agentInfo.mockReturnValue(null);
    h.handoffList.mockReturnValue([]);
    h.listPaneSnapshots.mockReturnValue([
      {
        paneId: 'pane-ds',
        sessionId: 'session-ds',
        kind: 'cli-agent',
        role: 'worker',
        state: 'idle',
        missionId: 'mission-f723',
      },
    ]);
    reroute.mockResolvedValue({ paneId: 'pane-novo', adapterId: 'codex' });
    adapterCircuitBreakers.reset();
    resetPaneStartWatchdogForTests();
    await shutdownDelegationSupervisor();
    prepareDelegationSupervisor();
    registerSuite();
  });
  afterEach(async () => {
    vi.useRealTimers();
    await shutdownDelegationSupervisor();
    resetPaneStartWatchdogForTests();
  });

  const deepseekWatch = (overrides: Partial<PaneStartWatchInit> = {}) =>
    trackPaneStart(
      watchInit({
        paneId: 'pane-ds',
        requestId: 'orchspawn-ds',
        adapterId: 'deepseek',
        turnProof: true,
        ...overrides,
      }),
    );

  const stopFailure = (
    stopFailureCategory: string,
    worked = false,
  ): Record<string, unknown> => ({
    sessionId: 'session-ds',
    paneId: 'pane-ds',
    sequence: 1,
    outcome: 'error',
    stopFailure: stopFailureCategory,
    worked,
    observedAt: NOW + 70_000,
  });

  const summaryOf = (call = 0): string =>
    String((h.submit.mock.calls[call]![0] as { summary: string }).summary);

  it('credencial recusada sem trabalho: fecha o pane, abre o disjuntor da chave, reroteia e avisa o Maestro', async () => {
    vi.useFakeTimers({ now: NOW, toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    deepseekWatch();

    // Antes do F-734 o turno aberto já encerrava a ficha aqui.
    await checkPaneStarts(NOW);
    expect(getPaneStartWatch('pane-ds')).not.toBeNull();
    expect(adapterCircuitBreakers.state('deepseek')).toBe('closed');

    h.turnEndTap!(stopFailure('auth'));
    // Falha provada não espera a varredura de 15 s.
    await vi.advanceTimersByTimeAsync(0);
    await flush();

    expect(h.trace).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'pane-start-rejected',
        paneId: 'pane-ds',
        adapterId: 'deepseek',
        missionId: 'mission-f723',
        cause: 'provider-auth',
      }),
    );
    expect(h.abandon).not.toHaveBeenCalled();
    expect(h.requestPaneClose).toHaveBeenCalledWith('pane-ds', 'session-ds');
    expect(reroute).toHaveBeenCalledTimes(1);
    expect(reroute).toHaveBeenCalledWith(['deepseek']);
    // Sem conta gerenciada a chave recusada é a de TODO pane da CLI.
    expect(adapterCircuitBreakers.isOpen('deepseek')).toBe(true);
    expect(h.submit).toHaveBeenCalledTimes(1);
    expect(h.submit.mock.calls[0]![0]).toMatchObject({
      missionId: 'mission-f723',
      status: 'progress',
      fromAgent: 'nexus-delegation-supervisor',
    });
    expect(summaryOf()).toBe(
      '[nao-iniciou:pane-ds] O pane pane-ds (deepseek) não começou a tarefa: ' +
        'credencial recusada pelo provedor (o turno do brief acabou antes de ' +
        'qualquer trabalho). Reenviada para codex (pane pane-novo).',
    );
    expect(h.onHandoffSubmitted).toHaveBeenCalledTimes(1);
    expect(h.trace).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'pane-not-started',
        paneId: 'pane-ds',
        cause: 'provider-auth',
        outcome: 'rerouted',
        breaker: 'trip',
        nextAdapterId: 'codex',
      }),
    );
    expect(getPaneStartWatch('pane-ds')).toBeNull();
    // Nem o aviso nem o trace carregam texto do provedor.
    expect(JSON.stringify(h.submit.mock.calls)).not.toContain('WXYZ');
    expect(JSON.stringify(h.trace.mock.calls)).not.toContain(PROVIDER_TEXT);

    // Nada se repete nas varreduras seguintes.
    await reconcileDelegationSupervisor(NOW + 60_000);
    await flush();
    expect(reroute).toHaveBeenCalledTimes(1);
    expect(h.submit).toHaveBeenCalledTimes(1);
  });

  it('com conta gerenciada a chave é da conta: o adapter só conta a falha (pausa por conta é do failover, F-676)', async () => {
    h.agentInfo.mockReturnValue({
      sessionId: 'session-ds',
      adapterId: 'deepseek',
      accountId: 'acct-ds-1',
    });
    deepseekWatch();
    h.turnEndTap!(stopFailure('billing'));
    await checkPaneStarts(NOW);

    expect(reroute).toHaveBeenCalledWith(['deepseek']);
    expect(adapterCircuitBreakers.snapshot('deepseek')).toMatchObject({
      state: 'closed',
      recentFailures: 1,
    });
    expect(summaryOf()).toContain('conta recusada pelo provedor — cobrança, crédito ou bloqueio');
    expect(h.trace).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'pane-not-started', cause: 'provider-billing', breaker: 'count' }),
    );
  });

  it('StopFailure depois de ferramenta: o pane começou (trabalhou e falhou depois)', async () => {
    deepseekWatch();
    h.turnEndTap!(stopFailure('auth', true));
    h.toolActivity.mockReturnValue(4);
    await checkPaneStarts(NOW);

    expect(reroute).not.toHaveBeenCalled();
    expect(h.requestPaneClose).not.toHaveBeenCalled();
    expect(h.submit).not.toHaveBeenCalled();
    expect(getPaneStartWatch('pane-ds')).toBeNull();
    expect(h.trace).not.toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'pane-start-rejected' }),
    );
  });

  it('limite de uso (rate_limit → other) é do failover: a ficha sai sem rerotear nem tocar no disjuntor', async () => {
    deepseekWatch();
    h.turnEndTap!(stopFailure('other'));
    h.lastTurnEnd.mockReturnValue(stopFailure('other'));
    await checkPaneStarts(NOW);

    expect(reroute).not.toHaveBeenCalled();
    expect(h.requestPaneClose).not.toHaveBeenCalled();
    expect(h.submit).not.toHaveBeenCalled();
    expect(getPaneStartWatch('pane-ds')).toBeNull();
    expect(adapterCircuitBreakers.snapshot('deepseek')).toMatchObject({
      state: 'closed',
      recentFailures: 0,
    });
  });

  it('handoff da sessão conta como trabalho: o StopFailure não é recusa', async () => {
    deepseekWatch();
    h.handoffList.mockReturnValue([{ id: 'handoff-w', sessionId: 'session-ds' }]);
    h.turnEndTap!(stopFailure('auth'));
    await checkPaneStarts(NOW);

    expect(reroute).not.toHaveBeenCalled();
    expect(h.submit).not.toHaveBeenCalled();
    expect(getPaneStartWatch('pane-ds')).toBeNull();
  });

  it('CLI pedida pelo operador: fecha e avisa com o motivo, sem trocar sozinho', async () => {
    deepseekWatch({ pinnedRuntime: true });
    h.turnEndTap!(stopFailure('auth'));
    await checkPaneStarts(NOW);

    expect(reroute).not.toHaveBeenCalled();
    expect(h.requestPaneClose).toHaveBeenCalledWith('pane-ds', 'session-ds');
    expect(adapterCircuitBreakers.isOpen('deepseek')).toBe(true);
    expect(summaryOf()).toContain('credencial recusada pelo provedor');
    expect(summaryOf()).toContain('A CLI foi pedida pelo operador');
  });

  it('pane aberto pelo operador (F-231): avisa, mas nunca fecha nem mexe no disjuntor', async () => {
    deepseekWatch({ operatorOpened: true });
    h.turnEndTap!(stopFailure('auth'));
    await checkPaneStarts(NOW);

    expect(h.requestPaneClose).not.toHaveBeenCalled();
    expect(reroute).not.toHaveBeenCalled();
    expect(adapterCircuitBreakers.snapshot('deepseek')).toMatchObject({
      state: 'closed',
      recentFailures: 0,
    });
    expect(summaryOf()).toContain('O pane é do operador e continua aberto');
  });

  it('sem o tap, a varredura acha a recusa no último fim de turno (pedido recusado só conta)', async () => {
    deepseekWatch();
    h.lastTurnEnd.mockReturnValue(stopFailure('invalid_request'));
    await checkPaneStarts(NOW);

    expect(reroute).toHaveBeenCalledWith(['deepseek']);
    expect(summaryOf()).toContain('pedido recusado pelo provedor — modelo ou parâmetro inválido');
    expect(adapterCircuitBreakers.snapshot('deepseek')).toMatchObject({
      state: 'closed',
      recentFailures: 1,
    });
    expect(h.trace).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'pane-start-rejected', cause: 'provider-request' }),
    );
  });

  it('turno do brief terminou normal e o seguinte falhou antes da varredura: o pane começou', async () => {
    deepseekWatch();
    h.turnEndTap!({ ...stopFailure('auth'), outcome: 'completed', stopFailure: undefined });
    // O Maestro escreveu no pane; o turno seguinte acabou em erro de pedido.
    h.turnEndTap!({ ...stopFailure('invalid_request'), sequence: 2 });
    h.lastTurnEnd.mockReturnValue({ ...stopFailure('invalid_request'), sequence: 2 });
    await checkPaneStarts(NOW);

    expect(reroute).not.toHaveBeenCalled();
    expect(h.requestPaneClose).not.toHaveBeenCalled();
    expect(h.submit).not.toHaveBeenCalled();
    expect(getPaneStartWatch('pane-ds')).toBeNull();
  });

  it('fim de turno de outra CLI no mesmo pane não vale para a ficha', async () => {
    h.agentInfo.mockReturnValue({ sessionId: 'session-ds', adapterId: 'claude' });
    deepseekWatch();
    h.turnEndTap!(stopFailure('auth'));
    expect(getPaneStartWatch('pane-ds')?.failure).toBeNull();
  });
});
