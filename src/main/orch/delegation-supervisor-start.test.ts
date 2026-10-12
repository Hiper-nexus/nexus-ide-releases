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
  checkLimitedTaskPanes,
  checkPaneStarts,
  prepareDelegationSupervisor,
  reconcileDelegationSupervisor,
  shutdownDelegationSupervisor,
} from './delegation-supervisor';
import {
  LIMIT_HANDOFF_MS,
  MODEL_REJECTION_HANDOFF_MS,
  START_GRACE_MS,
  executionProofGraceMs,
  getPaneStartWatch,
  noteConfirmedPaneLimit,
  notePaneStartAccepted,
  releasePaneStartWatch,
  resetPaneStartWatchdogForTests,
  trackPaneStart,
  type PaneStartWatchInit,
} from './pane-start-watchdog';
import { adapterCircuitBreakers } from './circuit-breaker';
import {
  getPaneTaskReroute,
  registerPaneTaskReroute,
  resetPaneTaskReroutesForTests,
  type PaneTaskRerouteRequest,
} from './pane-task-reroute';
import { modelAccessQuarantine, resetModelAccessQuarantineForTests } from './model-access-quarantine';
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
    missions: { list: () => [mission()], listIdsBatch: (after?: string) => after ? [] : [mission().id], get: () => mission(), setStatus: vi.fn() },
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
    resetModelAccessQuarantineForTests();
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
        // F-1410: o motivo real fica no trace local (diagnóstico), não no aviso.
        error: 'Qwen Code: modelo selado "qwen3.7-plus" não entrou no argv do spawn',
      }),
    );
    expect(getPaneStartWatch('pane-qwen')).toBeNull();

    // Nada se repete nas varreduras seguintes.
    await reconcileDelegationSupervisor(NOW + 60_000);
    await flush();
    expect(reroute).toHaveBeenCalledTimes(1);
    expect(h.submit).toHaveBeenCalledTimes(1);
  });

  it('recusa de capacidade (teto de panes) não reroteia e devolve a mensagem real ao Maestro', async () => {
    vi.useFakeTimers({ now: NOW, toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    trackPaneStart(watchInit());
    h.listPaneSnapshots.mockReturnValue([
      { paneId: 'pane-qwen', kind: 'cli-agent', role: 'worker', state: 'exited', missionId: 'mission-f723' },
    ]);
    h.pendingSession.mockReturnValue({ state: 'gone' });
    const capError =
      'pane_admission_cap: Teto de 12 panes de agente atingido (12 vivos). ' +
      'Nenhum pane ocioso para sugerir; feche panes que já entregaram. ' +
      'Ajuste o teto com NEXUS_PANE_CAP se esta máquina aguenta mais.';
    h.startFailureTap!({
      requestId: 'orchspawn-qwen',
      paneId: 'pane-qwen',
      adapterId: 'qwen',
      missionId: 'mission-f723',
      error: capError,
    });
    await vi.advanceTimersByTimeAsync(0);
    await flush();

    // F-1270(b): capacidade é CLI-agnóstica — outra CLI esbarra no mesmo teto,
    // então não reenvia para ninguém (nem conta como falha da CLI no disjuntor).
    expect(reroute).not.toHaveBeenCalled();
    expect(redeliver).not.toHaveBeenCalled();
    expect(adapterCircuitBreakers.snapshot('qwen').recentFailures).toBe(0);
    // A tentativa sem sessão continua sendo liquidada (nada nasce atrasado).
    expect(h.abandon).toHaveBeenCalledWith('orchspawn-qwen', expect.any(String));

    // F-1270(a): a mensagem REAL chega ao Maestro, sem o prefixo interno.
    expect(h.submit).toHaveBeenCalledTimes(1);
    const handoff = h.submit.mock.calls[0]![0] as Record<string, string>;
    expect(handoff.summary).toContain('Teto de 12 panes de agente atingido');
    expect(handoff.summary).not.toContain('pane_admission_cap');
    expect(handoff.summary).not.toContain('Reenviada para');
    expect(handoff.summary).toContain('não reenviei para outra CLI');
    expect(h.trace).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'pane-not-started',
        paneId: 'pane-qwen',
        cause: 'capacity-refused',
        outcome: 'not-rerouted',
        detail: expect.stringContaining('Teto de 12 panes de agente atingido'),
      }),
    );
    expect(getPaneStartWatch('pane-qwen')).toBeNull();
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

  it('boot failure diagnostics never request an unbounded output scan before recovery', async () => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
    trackPaneStart(watchInit());
    h.spawnedAt.mockReturnValue(NOW - 3_000);
    h.sessionOutput.mockImplementationOnce((_sessionId, lines) => {
      if (lines === undefined || lines > 100) throw new Error('unbounded boot diagnostic read');
      return '\nSynthetic boot error';
    });
    h.terminationTap!('bounded-boot', { paneId: 'pane-qwen', adapterId: 'qwen' });
    await checkPaneStarts(NOW);
    expect(reroute).toHaveBeenCalledWith(['qwen']);
    expect(h.trace.mock.calls.map(([event]) => event).find(event => event.kind === 'pane-not-started')?.outputTail).toContain('Synthetic boot error');
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

  it('F-984: AGY que não reconhece o modelo vira model-rejected, avisa o motivo e tira o modelo das rotas', async () => {
    vi.useFakeTimers({ now: NOW, toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    trackPaneStart(watchInit({ paneId: 'pane-agy', requestId: 'orchspawn-agy', adapterId: 'agy' }));
    h.spawnedAt.mockReturnValue(NOW - 3_838);
    h.agentInfo.mockReturnValue({ paneId: 'pane-agy', adapterId: 'agy', model: 'gemini-4-argon', accountId: null });
    // Saída real do pane-muym5dik-a (07/10 18:22, AGY 1.3.0).
    recordPaneSessionData(
      'session-agy-958',
      'error: invalid model selection (--model "gemini-4-argon" --effort ""): model gemini-4-argon ' +
        'is not recognized as a known model or custom model in settings\r\nAvailable models:\r\n' +
        'Gemini 3.8 Flash (High)\r\nGemini 3.8 Flash (Medium)\r\n',
    );
    h.terminationTap!(
      'session-agy-958',
      { paneId: 'pane-agy', adapterId: 'agy', oneShot: true },
      { exitCode: 1, signal: 0 },
    );
    await vi.advanceTimersByTimeAsync(0);
    await flush();

    expect(reroute).toHaveBeenCalledWith(['agy']);
    const event = h.trace.mock.calls.map(([value]) => value).find(
      (value) => value.kind === 'pane-not-started',
    );
    expect(event).toMatchObject({ paneId: 'pane-agy', cause: 'model-rejected', exitCode: 1 });
    const summary = (h.submit.mock.calls[0]![0] as { summary: string }).summary;
    expect(summary).toContain('a CLI instalada recusou o modelo roteado');
    expect(summary).toContain('não reconhece o modelo "gemini-4-argon"');
    expect(summary).toContain('saiu com código 1');
    expect(summary).not.toContain('Available models');
    // Rota e alternativas: o roteador consulta esta quarentena (F-683).
    expect(modelAccessQuarantine('agy', 'gemini-4-argon')).toContain('gemini-4-argon');
    expect(modelAccessQuarantine('agy', 'gemini-3.8-flash-high')).toBeNull();
  });

  it('F-984: writer Codex que sai com 74 aos 303 s (fila de pesados) sem começar avisa o Maestro com o motivo', async () => {
    vi.useFakeTimers({ now: NOW, toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    trackPaneStart(watchInit({
      paneId: 'pane-codex-w1',
      requestId: 'orchspawn-codex-w1',
      adapterId: 'codex',
      createdAt: NOW - 304_000,
    }));
    h.spawnedAt.mockReturnValue(NOW - 303_140);
    recordPaneSessionData('session-codex-w1', 'nexus-heavy: local admission request failed\r\n');
    h.terminationTap!(
      'session-codex-w1',
      { paneId: 'pane-codex-w1', adapterId: 'codex' },
      { exitCode: 74, signal: 0 },
    );
    await vi.advanceTimersByTimeAsync(0);
    await flush();

    const event = h.trace.mock.calls.map(([value]) => value).find(
      (value) => value.kind === 'pane-not-started',
    );
    expect(event).toMatchObject({ paneId: 'pane-codex-w1', cause: 'boot-exit', exitCode: 74 });
    expect(h.submit).toHaveBeenCalledTimes(1);
    const summary = (h.submit.mock.calls[0]![0] as { summary: string }).summary;
    expect(summary).toContain('[nao-iniciou:pane-codex-w1]');
    expect(summary).toContain('nexus-heavy');
    expect(summary).toContain('saiu com código 74');
    expect(h.onHandoffSubmitted).toHaveBeenCalledTimes(1);
  });

  it('F-1367: saída com erro após o teto de boot (791 s) vira worker-exit e não penaliza disjuntor', async () => {
    vi.useFakeTimers({ now: NOW, toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    trackPaneStart(watchInit({
      paneId: 'pane-agy-long',
      requestId: 'orchspawn-agy-long',
      adapterId: 'agy',
      createdAt: NOW - 795_000,
    }));
    h.spawnedAt.mockReturnValue(NOW - 791_000);
    recordPaneSessionData('session-agy-long', 'agy completed execution\r\n');
    h.terminationTap!(
      'session-agy-long',
      { paneId: 'pane-agy-long', adapterId: 'agy' },
      { exitCode: 3, signal: 0 },
    );
    await vi.advanceTimersByTimeAsync(0);
    await flush();

    const event = h.trace.mock.calls.map(([value]) => value).find(
      (value) => value.kind === 'pane-not-started' && value.paneId === 'pane-agy-long',
    );
    expect(event).toMatchObject({
      paneId: 'pane-agy-long',
      cause: 'worker-exit',
      exitCode: 3,
      breaker: 'skipped',
    });
    expect(adapterCircuitBreakers.snapshot('agy')).toMatchObject({
      state: 'closed',
      recentFailures: 0,
    });
    expect(h.submit).toHaveBeenCalledTimes(1);
    const summary = (h.submit.mock.calls[0]![0] as { summary: string }).summary;
    expect(summary).toContain('[nao-iniciou:pane-agy-long]');
    expect(summary).toContain('saiu com código 3');
    expect(h.onHandoffSubmitted).toHaveBeenCalledTimes(1);
  });

  it('F-984: saída LIMPA depois da graça continua sem veredito (não é morte)', async () => {
    vi.useFakeTimers({ now: NOW, toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    trackPaneStart(watchInit({ adapterId: 'codex', createdAt: NOW - 400_000 }));
    h.spawnedAt.mockReturnValue(NOW - 300_000);
    h.terminationTap!('session-clean', { paneId: 'pane-qwen', adapterId: 'codex' }, { exitCode: 0, signal: 0 });
    await vi.advanceTimersByTimeAsync(0);
    await checkPaneStarts(NOW);
    expect(h.submit).not.toHaveBeenCalled();
    expect(reroute).not.toHaveBeenCalled();
  });

  it('F-984: worker que já trabalhou (ferramenta) e sai com erro depois da graça não é "não iniciou"', async () => {
    vi.useFakeTimers({ now: NOW, toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    trackPaneStart(watchInit({ adapterId: 'codex', createdAt: NOW - 400_000 }));
    h.spawnedAt.mockReturnValue(NOW - 300_000);
    h.toolActivity.mockReturnValue(3);
    h.terminationTap!('session-worked', { paneId: 'pane-qwen', adapterId: 'codex' }, { exitCode: 1, signal: 0 });
    await vi.advanceTimersByTimeAsync(0);
    await checkPaneStarts(NOW);
    expect(h.submit).not.toHaveBeenCalled();
  });

  it('F-984: MiMo vivo sem NENHUM byte (spawning) depois da graça vira boot-silent e é avisado', async () => {
    trackPaneStart(watchInit({
      paneId: 'pane-mimo',
      requestId: 'orchspawn-mimo',
      adapterId: 'mimo-code',
      rerouted: true,
      // F-1414: já no teto de reaberturas do pedido.
      generation: 3,
      createdAt: NOW - START_GRACE_MS - 2_000,
    }));
    h.pendingSession.mockReturnValue({ state: 'bound', sessionId: 'session-mimo' });
    h.spawnedAt.mockReturnValue(NOW - START_GRACE_MS - 1_000);
    h.sessionState.mockReturnValue('spawning');
    h.listPaneSnapshots.mockReturnValue([
      { paneId: 'pane-mimo', kind: 'cli-agent', role: 'worker', state: 'spawning', sessionId: 'session-mimo', missionId: 'mission-f723' },
    ]);
    await checkPaneStarts(NOW);

    const event = h.trace.mock.calls.map(([value]) => value).find(
      (value) => value.kind === 'pane-not-started',
    );
    expect(event).toMatchObject({ paneId: 'pane-mimo', cause: 'boot-silent', outcome: 'not-rerouted' });
    expect(h.requestPaneClose).toHaveBeenCalledWith('pane-mimo', 'session-mimo');
    const summary = (h.submit.mock.calls[0]![0] as { summary: string }).summary;
    expect(summary).toContain('a CLI não escreveu nada no terminal');
  });

  it('F-984: sessão em spawning ainda dentro da graça não é julgada', async () => {
    trackPaneStart(watchInit({ adapterId: 'mimo-code', createdAt: NOW - 30_000 }));
    h.pendingSession.mockReturnValue({ state: 'bound', sessionId: 'session-mimo-early' });
    h.spawnedAt.mockReturnValue(NOW - 30_000);
    h.sessionState.mockReturnValue('spawning');
    await checkPaneStarts(NOW);
    expect(h.submit).not.toHaveBeenCalled();
    expect(reroute).not.toHaveBeenCalled();
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
    h.agentInfo.mockImplementation((sessionId) => sessionId === 'session-operador' ? { scope: SCOPE, adapterId: 'codex', role: 'user', cwd: '/workspace' } : null);
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
      expect.objectContaining({ assertCurrentAuthority: expect.any(Function) }),
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

  it('F-1414(e): a 3ª reabertura que também não sobe não reenvia de novo — bloqueia com o motivo (sem laço)', async () => {
    trackPaneStart(watchInit({ rerouted: true, generation: 3 }));
    h.startFailureTap!({ requestId: 'orchspawn-qwen', paneId: 'pane-qwen', error: 'x' });
    await checkPaneStarts(NOW);
    expect(reroute).not.toHaveBeenCalled();
    expect(h.submit.mock.calls[0]![0]).toMatchObject({
      missionId: 'mission-f723',
      status: 'blocked',
      fromAgent: 'nexus-delegation-supervisor',
    });
    expect(String((h.submit.mock.calls[0]![0] as { summary: string }).summary)).toContain(
      'A tarefa já foi reenviada 3 vezes; não reenvio de novo — bloqueada',
    );
  });

  it('F-1414(e): abaixo do teto (2ª reabertura) ainda reenvia — o teto é 3, não 1', async () => {
    trackPaneStart(watchInit({ rerouted: true, generation: 2 }));
    h.startFailureTap!({ requestId: 'orchspawn-qwen', paneId: 'pane-qwen', error: 'x' });
    await checkPaneStarts(NOW);
    expect(reroute).toHaveBeenCalledWith(['qwen']);
    expect(h.submit.mock.calls[0]![0]).toMatchObject({ status: 'progress' });
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

/**
 * F-1414 (operador, 12/10): "mandou algo, conferir se o pane está rodando —
 * às vezes está com quota cheia ou dá erro; se der erro, abrir outro com outra
 * LLM, ou aquela parte fica sem ser feita". A rede do supervisor exige PROVA
 * DE EXECUÇÃO (1º turno), não só a entrega do brief.
 */
describe('F-1414: tarefa delegada sem execução comprovada é reaberta noutra LLM', () => {
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
    h.sessionOutput.mockReturnValue('');
    h.agentInfo.mockReturnValue(null);
    h.handoffList.mockReturnValue([]);
    h.listPaneSnapshots.mockReturnValue([]);
    reroute.mockResolvedValue({ paneId: 'pane-novo', adapterId: 'codex' });
    redeliver.mockResolvedValue(false);
    adapterCircuitBreakers.reset();
    resetPaneStartWatchdogForTests();
    resetPaneTaskReroutesForTests();
    resetModelAccessQuarantineForTests();
    await shutdownDelegationSupervisor();
    prepareDelegationSupervisor();
    registerSuite();
  });
  afterEach(async () => {
    await shutdownDelegationSupervisor();
    resetPaneStartWatchdogForTests();
    resetPaneTaskReroutesForTests();
  });

  const summaryAt = (index = 0): string =>
    String((h.submit.mock.calls[index]![0] as { summary: string }).summary);

  /** Kimi Code 2.1.1 (12/10): vivo, brief parado no composer, tela ociosa. */
  function kimiStuckInComposer(spawnedAgoMs: number): void {
    trackPaneStart(watchInit({ paneId: 'pane-kimi', requestId: 'orchspawn-kimi', adapterId: 'kimi' }));
    h.pendingSession.mockReturnValue({ state: 'bound', sessionId: 'session-kimi' });
    h.spawnedAt.mockReturnValue(NOW - spawnedAgoMs);
    h.sessionState.mockReturnValue('idle');
    // O manifesto do Kimi publica a tela: conhecida e sem trabalho = idle.
    h.getSemantic.mockReturnValue({ status: 'idle', updatedAt: NOW - 1_000 });
    h.listPaneSnapshots.mockReturnValue([
      { paneId: 'pane-kimi', sessionId: 'session-kimi', kind: 'cli-agent', role: 'worker', state: 'idle', missionId: 'mission-f723' },
    ]);
  }

  it('(a) worker vivo sem 1º turno depois do prazo: fecha, reenvia para outro adapter e avisa o Maestro', async () => {
    // Kimi é CLI lenta conhecida: o prazo dela é maior que os 90 s padrão.
    expect(executionProofGraceMs('kimi')).toBeGreaterThan(START_GRACE_MS);
    kimiStuckInComposer(START_GRACE_MS + 5_000);
    await checkPaneStarts(NOW);
    // Dentro do prazo do Kimi: sem veredito, sem reenvio do brief.
    expect(reroute).not.toHaveBeenCalled();
    expect(redeliver).not.toHaveBeenCalled();
    expect(getPaneStartWatch('pane-kimi')).not.toBeNull();

    await checkPaneStarts(NOW + executionProofGraceMs('kimi'));
    expect(reroute).toHaveBeenCalledTimes(1);
    expect(reroute).toHaveBeenCalledWith(['kimi']);
    expect(h.requestPaneClose).toHaveBeenCalledWith('pane-kimi', 'session-kimi');
    expect(h.submit.mock.calls[0]![0]).toMatchObject({
      missionId: 'mission-f723',
      status: 'progress',
      fromAgent: 'nexus-delegation-supervisor',
    });
    expect(summaryAt()).toBe(
      '[nao-iniciou:pane-kimi] O pane pane-kimi (kimi) não começou a tarefa: a CLI está viva, ' +
        'mas nenhum turno começou no prazo (o brief ficou parado, sem execução). ' +
        'Reenviada para codex (pane pane-novo).',
    );
    expect(h.trace).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'pane-not-started', cause: 'turn-not-started', outcome: 'rerouted' }),
    );
    expect(getPaneStartWatch('pane-kimi')).toBeNull();
  });

  it('revisão Grok: worker que entrega enquanto o pane fecha não tem a tarefa reaberta noutra CLI', async () => {
    kimiStuckInComposer(10 * 60_000);
    h.requestPaneClose.mockImplementationOnce(async () => {
      // O handoff do worker chega no meio do fechamento.
      h.handoffList.mockReturnValue([{ id: 'h-kimi', sessionId: 'session-kimi' }]);
      return true;
    });
    await checkPaneStarts(NOW);
    expect(h.requestPaneClose).toHaveBeenCalledTimes(1);
    expect(reroute).not.toHaveBeenCalled();
    expect(h.submit).not.toHaveBeenCalled();
    expect(adapterCircuitBreakers.snapshot('kimi').recentFailures).toBe(0);
    expect(getPaneStartWatch('pane-kimi')).toBeNull();
  });

  it('(a) brief ACEITO pela colagem também não basta: sem turno no prazo, reenvia', async () => {
    trackPaneStart(watchInit({ adapterId: 'qwen' }));
    notePaneStartAccepted('pane-qwen', NOW - START_GRACE_MS);
    h.pendingSession.mockReturnValue({ state: 'bound', sessionId: 'session-qwen' });
    h.spawnedAt.mockReturnValue(NOW - START_GRACE_MS - 30_000);
    h.sessionState.mockReturnValue('idle');
    h.getSemantic.mockReturnValue({ status: 'idle', updatedAt: NOW - 1_000 });

    await checkPaneStarts(NOW);
    expect(reroute).toHaveBeenCalledWith(['qwen']);
    expect(summaryAt()).toContain('nenhum turno começou no prazo');
  });

  it('(a) PTY ocupado segue sem veredito (manifesto que não reconhece o trabalho não derruba quem trabalha)', async () => {
    kimiStuckInComposer(10 * 60_000);
    h.sessionState.mockReturnValue('busy');
    await checkPaneStarts(NOW);
    expect(reroute).not.toHaveBeenCalled();
    expect(h.submit).not.toHaveBeenCalled();
  });

  it('(b) estacionado pela admissão de memória antes do 1º turno: reenvia sem contar no disjuntor', async () => {
    trackPaneStart(watchInit({ paneId: 'pane-mimo', requestId: 'orchspawn-mimo', adapterId: 'mimo-code' }));
    h.pendingSession.mockReturnValue({ state: 'bound', sessionId: 'session-mimo' });
    h.spawnedAt.mockReturnValue(NOW - 20_000);
    h.sessionState.mockReturnValue('idle');
    await checkPaneStarts(NOW - 5_000);
    expect(getPaneStartWatch('pane-mimo')).not.toBeNull();

    // O guardian encerrou a CLI (encerramento pedido) e o pane ficou `parked`.
    h.terminationOrigin.mockReturnValue('pane-guardian:park');
    h.terminationTap!('session-mimo', { paneId: 'pane-mimo', adapterId: 'mimo-code' }, null);
    h.sessionState.mockReturnValue(null);
    h.listPaneSnapshots.mockReturnValue([
      { paneId: 'pane-mimo', sessionId: 'session-mimo', kind: 'cli-agent', role: 'worker', state: 'parked', missionId: 'mission-f723' },
    ]);
    await checkPaneStarts(NOW);

    expect(reroute).toHaveBeenCalledWith(['mimo-code']);
    // Revisão Fable (baixa): pane parked não tem sessão viva — fechar pela
    // sessão morta devolvia false e deixava um zumbi no layout.
    expect(h.requestPaneClose).toHaveBeenCalledWith('pane-mimo', undefined);
    expect(summaryAt()).toContain('o pane foi estacionado pela admissão de memória antes do primeiro turno');
    expect(summaryAt()).toContain('Reenviada para codex');
    // Memória não é falha da CLI.
    expect(adapterCircuitBreakers.snapshot('mimo-code').recentFailures).toBe(0);
  });

  it('(b) estacionado DEPOIS de começar (turno visto) não é reaberto', async () => {
    trackPaneStart(watchInit({ paneId: 'pane-mimo', requestId: 'orchspawn-mimo', adapterId: 'mimo-code' }));
    const watch = getPaneStartWatch('pane-mimo')!;
    watch.executionSeenAt = NOW - 30_000;
    h.listPaneSnapshots.mockReturnValue([
      { paneId: 'pane-mimo', sessionId: null, kind: 'cli-agent', role: 'worker', state: 'parked', missionId: 'mission-f723' },
    ]);
    await checkPaneStarts(NOW);
    expect(reroute).not.toHaveBeenCalled();
    expect(h.submit).not.toHaveBeenCalled();
  });

  it('(d) worker que começou o turno: a ficha sai sem reenvio, mesmo ocioso depois do prazo', async () => {
    kimiStuckInComposer(10 * 60_000);
    h.getSemantic.mockReturnValue({ status: 'working', updatedAt: NOW - 1_000 });
    await checkPaneStarts(NOW);
    // Turno aberto assenta (F-765) e vira início.
    await checkPaneStarts(NOW + 15_000);
    expect(getPaneStartWatch('pane-kimi')).toBeNull();

    h.getSemantic.mockReturnValue({ status: 'idle', updatedAt: NOW + 60_000 });
    await checkPaneStarts(NOW + 10 * 60_000);
    expect(reroute).not.toHaveBeenCalled();
    expect(h.requestPaneClose).not.toHaveBeenCalled();
    expect(h.submit).not.toHaveBeenCalled();
  });

  describe('(c) limite de uso confirmado antes da entrega', () => {
    const taskReroute = vi.fn(async (_request: PaneTaskRerouteRequest) => ({
      paneId: 'pane-novo',
      adapterId: 'codex',
    }));

    function museWorkerAtLimit(generation = 0, at = NOW, sessionId = 'session-muse'): void {
      registerPaneTaskReroute({
        paneId: 'pane-muse',
        adapterId: 'muse',
        missionId: 'mission-f723',
        role: 'worker',
        callerSessionId: 'session-maestro',
        routeTask: 'implementar o login',
        lineageId: 'pane-orig',
        operatorOpened: false,
        pinnedRuntime: false,
        generation,
        reroute: taskReroute,
        hasAlternative: () => true,
      }, at);
      h.listPaneSnapshots.mockReturnValue([
        { paneId: 'pane-muse', sessionId, kind: 'cli-agent', role: 'worker', state: 'idle', missionId: 'mission-f723', scope: SCOPE },
      ]);
      h.sessionState.mockReturnValue('idle');
      noteConfirmedPaneLimit({
        paneId: 'pane-muse',
        sessionId,
        adapterId: 'muse',
        reason: 'Usage limit reached',
        at,
      });
    }

    beforeEach(() => taskReroute.mockClear());

    it('o failover tem o prazo dele; depois, fecha o pane e reabre noutra CLI na mesma worktree', async () => {
      museWorkerAtLimit();
      await checkLimitedTaskPanes(NOW + LIMIT_HANDOFF_MS - 1);
      expect(taskReroute).not.toHaveBeenCalled();

      await checkLimitedTaskPanes(NOW + LIMIT_HANDOFF_MS);
      expect(h.requestPaneClose).toHaveBeenCalledWith('pane-muse', 'session-muse');
      expect(taskReroute).toHaveBeenCalledWith({
        excludeAdapterIds: ['muse'],
        worktreeFromPaneId: 'pane-muse',
      });
      expect(getPaneTaskReroute('pane-muse')).toBeNull();
      expect(h.submit.mock.calls[0]![0]).toMatchObject({
        missionId: 'mission-f723',
        status: 'progress',
        fromAgent: 'nexus-delegation-supervisor',
      });
      expect(summaryAt()).toBe(
        '[limite:pane-muse] O pane pane-muse (muse) bateu o limite de uso confirmado ' +
          '(Usage limit reached) antes de entregar a tarefa. Reenviada para codex ' +
          '(pane pane-novo), na mesma worktree quando havia uma.',
      );
      // Uma vez só.
      await checkLimitedTaskPanes(NOW + 2 * LIMIT_HANDOFF_MS);
      expect(taskReroute).toHaveBeenCalledTimes(1);
    });

    it('quem já entregou (handoff da sessão) não é reaberto', async () => {
      museWorkerAtLimit();
      h.handoffList.mockReturnValue([{ id: 'h1', sessionId: 'session-muse' }]);
      await checkLimitedTaskPanes(NOW + LIMIT_HANDOFF_MS);
      expect(taskReroute).not.toHaveBeenCalled();
      expect(h.submit).not.toHaveBeenCalled();
    });

    it('o failover já trocou (sessão nova no pane): nada a fazer', async () => {
      museWorkerAtLimit();
      h.listPaneSnapshots.mockReturnValue([
        { paneId: 'pane-muse', sessionId: 'session-muse-2', kind: 'cli-agent', role: 'worker', state: 'busy', missionId: 'mission-f723', scope: SCOPE },
      ]);
      await checkLimitedTaskPanes(NOW + LIMIT_HANDOFF_MS);
      expect(taskReroute).not.toHaveBeenCalled();
      expect(h.requestPaneClose).not.toHaveBeenCalled();
    });

    it('revisão Fable M2: PTY ocupado (Muse refazendo sozinho, sem status semântico) não recebe veredito', async () => {
      museWorkerAtLimit();
      h.sessionState.mockReturnValue('busy');
      await checkLimitedTaskPanes(NOW + LIMIT_HANDOFF_MS);
      expect(taskReroute).not.toHaveBeenCalled();
      expect(h.requestPaneClose).not.toHaveBeenCalled();
      expect(h.submit).not.toHaveBeenCalled();
      // Ocupado só adia: parado de novo e sem saída nova, a rede age.
      h.sessionState.mockReturnValue('idle');
      await checkLimitedTaskPanes(NOW + 2 * LIMIT_HANDOFF_MS);
      expect(taskReroute).toHaveBeenCalledTimes(1);
    });

    it('revisão Fable M2: saída nova no PTY depois do limite cancela a reabertura', async () => {
      const at = Date.now() - 2 * LIMIT_HANDOFF_MS;
      // Sessão própria: o buffer de saída é global entre os testes.
      museWorkerAtLimit(0, at, 'session-muse-out');
      recordPaneSessionData('session-muse-out', 'retrying… resposta nova\r\n');
      await checkLimitedTaskPanes(Date.now());
      expect(taskReroute).not.toHaveBeenCalled();
      expect(h.requestPaneClose).not.toHaveBeenCalled();
      expect(h.submit).not.toHaveBeenCalled();
    });

    it('(e) no teto de reaberturas: não reabre, deixa o pane e bloqueia com o motivo', async () => {
      museWorkerAtLimit(3);
      await checkLimitedTaskPanes(NOW + LIMIT_HANDOFF_MS);
      expect(taskReroute).not.toHaveBeenCalled();
      expect(h.requestPaneClose).not.toHaveBeenCalled();
      expect(h.submit.mock.calls[0]![0]).toMatchObject({ status: 'blocked' });
      expect(summaryAt()).toContain('A tarefa já foi reenviada 3 vezes');
    });
  });
});
