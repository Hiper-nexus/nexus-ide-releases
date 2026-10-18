import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Handoff } from '../../shared/orch-types';
import type { ProjectExecutionScope } from '../../shared/types';
import { testProjectScope } from './__tests__/scope-fixture';

const ptyMocks = vi.hoisted(() => ({
  state: 'busy' as string | null,
  writes: vi.fn((_sessionId: string, _data: string) => true),
  stateTaps: [] as Array<(sessionId: string, state: string) => void>,
  exitTaps: [] as Array<(sessionId: string) => void>,
  dataTaps: [] as Array<(sessionId: string, data: string) => void>,
  adapters: new Map<string, string>(),
}));

const paneMocks = vi.hoisted(() => ({
  authorities: new Map<string, unknown>(),
}));

const semanticMocks = vi.hoisted(() => ({
  injectable: true,
  status: 'idle' as 'idle' | 'completed' | 'awaiting-input' | 'working',
  updatedAt: Date.now(),
  turnSequence: 0,
  taps: [] as Array<(entry: {
    sessionId: string;
    status: 'idle' | 'completed' | 'awaiting-input' | 'working';
    updatedAt?: number;
  }) => void>,
  turnStartTaps: [] as Array<(entry: {
    sessionId: string;
    paneId: string;
    sequence: number;
    observedAt: number;
  }) => void>,
}));

const scopeMocks = vi.hoisted(() => ({
  scopesByOwner: new Map<number, ProjectExecutionScope>(),
  listeners: [] as Array<
    (
      owner: { id: number },
      previous: ProjectExecutionScope | null,
      next: ProjectExecutionScope | null,
    ) => void
  >,
}));

const storeMocks = vi.hoisted(() => ({
  missions: new Map<
    string,
    {
      id?: string;
      orchestratorSessionId?: string;
      status?: string;
      description?: string;
      intentVersion?: number;
      kickoffAccepted?: boolean;
    }
  >(),
  missionUpdates: [] as Array<{
    scope: ProjectExecutionScope;
    id: string;
    patch: { status?: string; description?: string };
  }>,
  handoffs: new Map<string, Handoff>(),
  taskDispatches: [] as Array<{
    handoffId: string;
    missionId: string;
    intentVersion?: number;
    revision?: number;
    sessionId?: string;
    workerIncarnationId?: string;
    workerId?: string;
    handoffAcceptedAt?: number;
    state: string;
    executionMode: 'isolated_worktree' | 'same_checkout' | 'read_only';
    ownership: {
      files: string[];
      symbols: string[];
      domains: string[];
    };
  }>,
  delivered: [] as Array<{ scope: ProjectExecutionScope; id: string }>,
  consumed: [] as Array<{ scope: ProjectExecutionScope; id: string }>,
  deliveryAttempts: new Map<string, {
    id: string;
    handoffId: string;
    missionId: string;
    orchestratorSessionId: string;
    attemptNo: number;
    state: 'reserved' | 'pasted' | 'accepted' | 'failed';
    released?: boolean;
  }>(),
  nextAttemptId: 1,
  /**
   * F-1006: espelha o store real — tentativa colada cujo handoff já saiu de
   * `queued` (ACK do Maestro chegou antes da borda busy) lança o CAS perdido.
   */
  strictAcceptCas: false,
}));

const civilianMocks = vi.hoisted(() => ({
  maybeComplete: vi.fn(),
}));
vi.mock('./civilian-delivery-completion', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./civilian-delivery-completion')>();
  civilianMocks.maybeComplete.mockImplementation(
    (...args: Parameters<typeof actual.maybeCompleteFastLaneOnDelivery>) =>
      actual.maybeCompleteFastLaneOnDelivery(...args),
  );
  return { ...actual, maybeCompleteFastLaneOnDelivery: civilianMocks.maybeComplete };
});

const missionLeaderGateMocks = vi.hoisted(() => ({
  requireMissionLeaderSession: vi.fn(
    (
      scope: ProjectExecutionScope,
      missionId: string,
      ctx: { sessionId?: string | null },
    ): import('./mission-leader-gate').MissionLeaderGateResult => {
      const leaderSessionId = storeMocks.missions.get(
        `${scope.projectId}:${scope.checkoutId}:${missionId}`,
      )?.orchestratorSessionId;
      if (!leaderSessionId) {
        return { ok: false as const, code: 'no-leader' as const, hint: 'sem líder durável' };
      }
      if (Object.hasOwn(ctx, 'sessionId') && ctx.sessionId !== leaderSessionId) {
        return { ok: false as const, code: 'stale-session' as const, hint: 'sessão obsoleta' };
      }
      return {
        ok: true as const,
        leader: { sessionId: leaderSessionId, paneId: null, source: 'live' as const, proven: true },
      };
    },
  ),
}));
vi.mock('./mission-leader-gate', () => ({
  requireMissionLeaderSession: missionLeaderGateMocks.requireMissionLeaderSession,
}));

const missionEventMocks = vi.hoisted(() => ({
  emitMissionEvent: vi.fn(() => true),
}));
vi.mock('./mission-event-emit', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./mission-event-emit')>()),
  emitMissionEvent: missionEventMocks.emitMissionEvent,
}));

vi.mock('../pty/pty-manager', () => ({
  getSessionState: vi.fn(() => ptyMocks.state),
  orchWriteSession: ptyMocks.writes,
  tapSessionState: vi.fn(
    (tap: (sessionId: string, state: string) => void) => {
      ptyMocks.stateTaps.push(tap);
      return () => {
        const index = ptyMocks.stateTaps.indexOf(tap);
        if (index >= 0) ptyMocks.stateTaps.splice(index, 1);
      };
    },
  ),
  tapSessionExit: vi.fn((tap: (sessionId: string) => void) => {
    ptyMocks.exitTaps.push(tap);
    return () => {
      const index = ptyMocks.exitTaps.indexOf(tap);
      if (index >= 0) ptyMocks.exitTaps.splice(index, 1);
    };
  }),
  tapSessionData: vi.fn((tap: (sessionId: string, data: string) => void) => {
    ptyMocks.dataTaps.push(tap);
    return () => {
      const index = ptyMocks.dataTaps.indexOf(tap);
      if (index >= 0) ptyMocks.dataTaps.splice(index, 1);
    };
  }),
  getAgentSessionInfo: vi.fn((sessionId: string) => {
    const adapterId = ptyMocks.adapters.get(sessionId);
    return adapterId ? { adapterId } : null;
  }),
}));

// Paste markers now come from off-Main analysis. Keep the real reducer and
// replace only its transport, as in paste-ingest.test.ts; raw legacy taps do
// not reach watchPasteIngest after F-863.
vi.mock('../pty/pty-analysis-runtime', async () => {
  const { PtyAnalysisCore } = await import('../pty/pty-analysis-core');
  return { watchPtyAnalysisSession: (_consumer: string, id: string, config: object, callback: (value: unknown) => void) => {
    let seq = 0;
    const core = new PtyAnalysisCore([], result => {
      for (const event of result.events) if (event.consumer === 'paste') callback(event.value);
    });
    const feed = (body: object) => core.process({ sessionId: id, generation: 1, workerEpoch: 1, eventSeq: ++seq, observedAt: Date.now(), ...body } as Parameters<typeof core.process>[0]);
    feed({ kind: 'bind', binding: { adapterId: ptyMocks.adapters.get(id) } });
    feed({ kind: 'arm', consumer: 'paste', registration: 1, config });
    const tap = (sessionId: string, data: string) => { if (sessionId === id) feed({ kind: 'data', data }); };
    ptyMocks.dataTaps.push(tap);
    return () => { const index = ptyMocks.dataTaps.indexOf(tap); if (index >= 0) ptyMocks.dataTaps.splice(index, 1); core.close(); };
  } };
});

vi.mock('./pane-registry', () => ({
  getOwnedPaneAuthzInfoBySession: vi.fn(
    (ref: string) => paneMocks.authorities.get(ref) ?? null,
  ),
  getPaneRuntimeAuthorityBySession: vi.fn(
    (ref: string) => paneMocks.authorities.get(ref) ?? null,
  ),
}));

vi.mock('./agent-status', () => ({
  isSessionInjectableIdle: vi.fn(() => {
    if (ptyMocks.state !== 'idle') return false;
    if (semanticMocks.status === 'awaiting-input') return false;
    if (semanticMocks.status === 'working') return semanticMocks.injectable;
    return true;
  }),
  getAgentSemanticStatusBySession: vi.fn(() => ({
    status: semanticMocks.status,
    updatedAt: semanticMocks.updatedAt,
  })),
  getAgentTurnStartSequence: vi.fn(() => semanticMocks.turnSequence),
  tapAgentTurnStart: vi.fn((tap: (entry: {
    sessionId: string;
    paneId: string;
    sequence: number;
    observedAt: number;
  }) => void) => {
    semanticMocks.turnStartTaps.push(tap);
    return () => {
      const idx = semanticMocks.turnStartTaps.indexOf(tap);
      if (idx >= 0) semanticMocks.turnStartTaps.splice(idx, 1);
    };
  }),
  tapAgentSemanticStatus: vi.fn((tap: (entry: {
    sessionId: string;
    status: 'idle' | 'completed' | 'awaiting-input' | 'working';
  }) => void) => {
    semanticMocks.taps.push(tap);
    return () => {
      const index = semanticMocks.taps.indexOf(tap);
      if (index >= 0) semanticMocks.taps.splice(index, 1);
    };
  }),
}));

vi.mock('../persistence/renderer-workspace-scope', () => ({
  getRendererWorkspaceScope: vi.fn(
    (owner: { id: number }) => scopeMocks.scopesByOwner.get(owner.id) ?? null,
  ),
  onRendererWorkspaceScopeChange: vi.fn(
    (
      listener: (
        owner: { id: number },
        previous: ProjectExecutionScope | null,
        next: ProjectExecutionScope | null,
      ) => void,
    ) => {
      scopeMocks.listeners.push(listener);
      return () => {
        const index = scopeMocks.listeners.indexOf(listener);
        if (index >= 0) scopeMocks.listeners.splice(index, 1);
      };
    },
  ),
}));

vi.mock('./project-domain-store-registry', () => ({
  getProjectDomainStores: vi.fn((scope: ProjectExecutionScope) => ({
    missions: {
      get: (id: string) =>
        storeMocks.missions.get(`${scope.projectId}:${scope.checkoutId}:${id}`) ??
        null,
      hasCurrentKickoffAcceptance: (id: string) =>
        storeMocks.missions.get(`${scope.projectId}:${scope.checkoutId}:${id}`)
          ?.kickoffAccepted === true,
      update: (id: string, patch: { status?: string; description?: string }) => {
        storeMocks.missionUpdates.push({ scope, id, patch });
        const key = `${scope.projectId}:${scope.checkoutId}:${id}`;
        const current = storeMocks.missions.get(key);
        if (!current) return null;
        const next = { ...current, ...patch };
        storeMocks.missions.set(key, next);
        return next;
      },
    },
    taskDispatches: {
      list: (missionId?: string) =>
        storeMocks.taskDispatches.filter(
          (row) => !missionId || row.missionId === missionId,
        ),
    },
    handoffs: {
      get: (id: string) =>
        storeMocks.handoffs.get(id) ?? handoff({ id }),
      markSubmitted: (id: string) => storeMocks.delivered.push({ scope, id }),
      reserveDeliveryAttempt: ({
        handoffId,
        missionId,
        orchestratorSessionId,
        maxAttempts,
      }: {
        handoffId: string;
        missionId: string;
        orchestratorSessionId: string;
        maxAttempts: number;
      }) => {
        for (const attempt of storeMocks.deliveryAttempts.values()) {
          if (
            attempt.handoffId === handoffId &&
            (attempt.state === 'reserved' || attempt.state === 'pasted')
          ) attempt.state = 'failed';
        }
        const priorAttempts = [...storeMocks.deliveryAttempts.values()].filter(
          (attempt) => attempt.handoffId === handoffId,
        );
        const sessionAttempts = priorAttempts.filter(
          (attempt) =>
            attempt.orchestratorSessionId === orchestratorSessionId &&
            !attempt.released,
        ).length;
        if (sessionAttempts >= maxAttempts) {
          throw new Error('handoff delivery attempt budget exhausted');
        }
        const attemptNo = priorAttempts.length + 1;
        const attempt = {
          id: `attempt-${storeMocks.nextAttemptId++}`,
          handoffId,
          missionId,
          orchestratorSessionId,
          attemptNo,
          state: 'reserved' as const,
        };
        storeMocks.deliveryAttempts.set(attempt.id, attempt);
        return attempt;
      },
      markDeliveryAttemptPasted: ({ attemptId }: { attemptId: string }) => {
        const attempt = storeMocks.deliveryAttempts.get(attemptId)!;
        attempt.state = 'pasted';
        return attempt;
      },
      failDeliveryAttempt: ({ attemptId }: { attemptId: string }) => {
        const attempt = storeMocks.deliveryAttempts.get(attemptId);
        if (!attempt || (attempt.state !== 'reserved' && attempt.state !== 'pasted')) {
          return false;
        }
        attempt.state = 'failed';
        return true;
      },
      releaseFailedDeliveryAttempts: ({
        handoffId,
        orchestratorSessionId,
      }: {
        handoffId: string;
        orchestratorSessionId: string;
      }) => {
        let released = 0;
        for (const attempt of storeMocks.deliveryAttempts.values()) {
          if (
            attempt.handoffId === handoffId &&
            attempt.orchestratorSessionId === orchestratorSessionId &&
            attempt.state === 'failed' &&
            !attempt.released
          ) {
            attempt.released = true;
            released += 1;
          }
        }
        return released;
      },
      listDeliveryAttempts: (handoffId: string) =>
        [...storeMocks.deliveryAttempts.values()].filter(
          (attempt) => attempt.handoffId === handoffId,
        ),
      acceptDeliveryAttempt: ({
        attemptId,
        handoffId,
      }: { attemptId: string; handoffId: string }) => {
        const attempt = storeMocks.deliveryAttempts.get(attemptId);
        if (!attempt || attempt.state !== 'pasted') return false;
        if (
          storeMocks.strictAcceptCas &&
          (storeMocks.handoffs.get(handoffId)?.deliveryState ?? 'queued') !== 'queued'
        ) {
          // A transação real faz rollback: a tentativa continua `pasted`.
          throw new Error('handoff submission lost delivery-attempt CAS');
        }
        attempt.state = 'accepted';
        storeMocks.delivered.push({ scope, id: handoffId });
        const current = storeMocks.handoffs.get(handoffId);
        if (current) {
          storeMocks.handoffs.set(handoffId, {
            ...current,
            delivered: true,
            deliveryState: 'submitted',
          });
        }
        return true;
      },
      markConsumedAfterAcceptedDelivery: (
        handoffId: string,
        _missionId: string,
        _sessionId: string,
      ) => {
        const current = storeMocks.handoffs.get(handoffId) ?? handoff({ id: handoffId });
        if (
          !current.delivered &&
          current.deliveryState !== 'submitted' &&
          current.deliveryState !== 'acknowledged'
        ) {
          return false;
        }
        storeMocks.handoffs.set(handoffId, {
          ...current,
          delivered: true,
          deliveryState: 'consumed',
        });
        storeMocks.consumed.push({ scope, id: handoffId });
        return true;
      },
      list: ({ missionId }: { missionId?: string }) =>
        [...storeMocks.handoffs.values()].filter(
          (item) => !item.delivered && (!missionId || item.missionId === missionId),
        ),
    },
  })),
}));

function handoff(overrides: Partial<Handoff> = {}): Handoff {
  return {
    id: 'handoff-a',
    missionId: 'mission-a',
    sessionId: 'worker-session',
    fromAgent: 'worker-a',
    status: 'success',
    claimTrust: 'untrusted',
    summary: 'completed the requested work',
    artifacts: [],
    evidenceIds: [],
    evidenceTrust: 'unverified',
    delivered: false,
    deliveryState: 'queued',
    createdAt: 1,
    ...overrides,
  };
}

function schedulerHandoff(overrides: Partial<Handoff> = {}): Handoff {
  return handoff({
    sessionId: 'worker-session',
    workerIncarnationId: 'worker-incarnation',
    fromAgent: 'worker-a',
    authorityOrigin: 'agent',
    mcpProvenance: {
      receiptId: 'handoff-tool-call',
      toolCallId: 'handoff-tool-call',
      toolName: 'nexus_handoff_submit',
      source: 'http-mcp',
      missionId: 'mission-a',
      sessionId: 'worker-session',
      workerIncarnationId: 'worker-incarnation',
      authoritySha256: 'a'.repeat(64),
      issuedAt: 1,
    },
    createdAt: 2,
    ...overrides,
  });
}

function authorizeSchedulerOwnedHandoff(
  scope: ProjectExecutionScope,
  overrides: Partial<(typeof storeMocks.taskDispatches)[number]> = {},
): Handoff {
  const current = schedulerHandoff();
  storeMocks.missions.set(
    `${scope.projectId}:${scope.checkoutId}:mission-a`,
    {
      id: 'mission-a',
      orchestratorSessionId: 'orchestrator-session',
      status: 'running',
      description: 'Objetivo original',
      intentVersion: 7,
      kickoffAccepted: true,
    },
  );
  storeMocks.handoffs.set(current.id, current);
  storeMocks.taskDispatches.push({
    handoffId: current.id,
    missionId: 'mission-a',
    intentVersion: 7,
    revision: 3,
    sessionId: current.sessionId,
    workerIncarnationId: current.workerIncarnationId,
    workerId: current.fromAgent,
    handoffAcceptedAt: 3,
    state: 'merging',
    executionMode: 'isolated_worktree',
    ownership: { files: [], symbols: [], domains: [] },
    ...overrides,
  });
  return current;
}

function authorizeTarget(
  scope: ProjectExecutionScope,
  owner: { id: number } = { id: 101 },
): void {
  storeMocks.missions.set(
    `${scope.projectId}:${scope.checkoutId}:mission-a`,
    {
      id: 'mission-a',
      orchestratorSessionId: 'orchestrator-session',
      status: 'running',
      description: 'Objetivo original',
    },
  );
  paneMocks.authorities.set('orchestrator-session', {
    owner,
    paneId: 'orchestrator-pane',
    sessionId: 'orchestrator-session',
    kind: 'cli-agent',
    missionId: 'mission-a',
    role: 'orchestrator',
    scope,
  });
  scopeMocks.scopesByOwner.set(owner.id, scope);
}

function authorizeMainOwnedTarget(scope: ProjectExecutionScope): void {
  storeMocks.missions.set(
    `${scope.projectId}:${scope.checkoutId}:mission-a`,
    {
      id: 'mission-a',
      orchestratorSessionId: 'orchestrator-session',
      status: 'running',
      description: 'Objetivo original',
    },
  );
  paneMocks.authorities.set('orchestrator-session', {
    owner: null,
    paneId: 'orchestrator-pane',
    sessionId: 'orchestrator-session',
    kind: 'cli-agent',
    missionId: 'mission-a',
    role: 'orchestrator',
    scope,
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.resetModules();
  ptyMocks.state = 'busy';
  ptyMocks.writes.mockReset();
  ptyMocks.writes.mockReturnValue(true);
  ptyMocks.stateTaps.length = 0;
  ptyMocks.exitTaps.length = 0;
  ptyMocks.dataTaps.length = 0;
  ptyMocks.adapters.clear();
  paneMocks.authorities.clear();
  semanticMocks.injectable = true;
  semanticMocks.status = 'idle';
  semanticMocks.taps.length = 0;
  scopeMocks.scopesByOwner.clear();
  scopeMocks.listeners.length = 0;
  storeMocks.missions.clear();
  storeMocks.missionUpdates.length = 0;
  storeMocks.handoffs.clear();
  storeMocks.taskDispatches.length = 0;
  storeMocks.delivered.length = 0;
  storeMocks.consumed.length = 0;
  storeMocks.deliveryAttempts.clear();
  storeMocks.nextAttemptId = 1;
  storeMocks.strictAcceptCas = false;
  civilianMocks.maybeComplete.mockClear();
  missionEventMocks.emitMissionEvent.mockClear();
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

async function advanceUntilPasted(
  delivery: typeof import('./idle-delivery'),
): Promise<void> {
  await vi.advanceTimersByTimeAsync(delivery.DELIVERY_IDLE_STABILITY_MS);
}

async function advanceUntilSubmitted(
  delivery: typeof import('./idle-delivery'),
): Promise<void> {
  await vi.advanceTimersByTimeAsync(
    delivery.DELIVERY_IDLE_STABILITY_MS + delivery.HANDOFF_PROMPT_SETTLE_MS,
  );
}

describe('idle delivery authority and lifecycle', { timeout: 60_000 }, () => {
  it('does not paste or submit while an idle-looking permission prompt is active', async () => {
    const delivery = await import('./idle-delivery');
    const scope = testProjectScope();
    authorizeTarget(scope);
    ptyMocks.state = 'idle';
    semanticMocks.injectable = false;
    semanticMocks.status = 'awaiting-input';
    delivery.initIdleDelivery();

    delivery.onHandoffSubmitted(handoff(), scope);
    expect(ptyMocks.writes).not.toHaveBeenCalled();

    semanticMocks.injectable = true;
    semanticMocks.status = 'completed';
    await vi.advanceTimersByTimeAsync(500);
    await advanceUntilSubmitted(delivery);
    expect(ptyMocks.writes).toHaveBeenCalledTimes(2);
    expect(ptyMocks.writes).toHaveBeenLastCalledWith(
      'orchestrator-session',
      '\r',
      { markInputBusy: false },
    );
    delivery.shutdownIdleDelivery();
  });

  it('denies delivery on split-brain leadership without picking a winner, and never wedges the mission', async () => {
    const delivery = await import('./idle-delivery');
    const scope = testProjectScope();
    authorizeTarget(scope);
    ptyMocks.state = 'idle';
    delivery.initIdleDelivery();
    missionLeaderGateMocks.requireMissionLeaderSession.mockReturnValueOnce({
      ok: false, code: 'split-brain', hint: 'duas sessões vivas reivindicam a missão',
    });

    expect(() => delivery.onHandoffSubmitted(handoff(), scope)).not.toThrow();
    await vi.advanceTimersByTimeAsync(500);
    expect(ptyMocks.writes).not.toHaveBeenCalled();

    // Once leadership resolves cleanly again, a fresh handoff still delivers
    // — the earlier split-brain denial left no permanent wedge behind.
    delivery.onHandoffSubmitted(handoff({ id: 'handoff-b' }), scope);
    await vi.advanceTimersByTimeAsync(500);
    expect(ptyMocks.writes).toHaveBeenCalled();
    delivery.shutdownIdleDelivery();
  });

  it('denies delivery to a stale orchestrator session even when a pane authority still exists for it', async () => {
    const delivery = await import('./idle-delivery');
    const scope = testProjectScope();
    authorizeTarget(scope);
    ptyMocks.state = 'idle';
    delivery.initIdleDelivery();
    missionLeaderGateMocks.requireMissionLeaderSession.mockReturnValueOnce({
      ok: false, code: 'stale-session', hint: 'outra sessão assumiu a missão',
    });

    delivery.onHandoffSubmitted(handoff(), scope);
    await vi.advanceTimersByTimeAsync(500);
    expect(ptyMocks.writes).not.toHaveBeenCalled();
    delivery.shutdownIdleDelivery();
  });

  it('delivers to a main-owned orchestrator while no renderer is alive', async () => {
    const delivery = await import('./idle-delivery');
    const scope = testProjectScope();
    authorizeMainOwnedTarget(scope);
    ptyMocks.state = 'idle';
    delivery.initIdleDelivery();

    delivery.onHandoffSubmitted(handoff(), scope);
    await vi.advanceTimersByTimeAsync(150);

    expect(ptyMocks.writes).toHaveBeenCalledWith(
      'orchestrator-session',
      expect.stringContaining('handoff_id=handoff-a'),
      { markInputBusy: false },
    );
    delivery.shutdownIdleDelivery();
  });

  it('labels success as an untrusted worker report that cannot complete a mission', async () => {
    const delivery = await import('./idle-delivery');
    const scope = testProjectScope();
    authorizeTarget(scope);
    ptyMocks.state = 'idle';
    delivery.initIdleDelivery();

    delivery.onHandoffSubmitted(handoff(), scope);
    await vi.advanceTimersByTimeAsync(150);

    expect(ptyMocks.writes).toHaveBeenCalledWith(
      'orchestrator-session',
      expect.stringMatching(
        /reported_status=success.*claim_trust=untrusted.*evidence=unverified.*does_not_complete_mission/i,
      ),
      { markInputBusy: false },
    );
    delivery.shutdownIdleDelivery();
  });

  it('labels nexus-delegation-supervisor recovery as system (not untrusted spam)', async () => {
    const delivery = await import('./idle-delivery');
    const scope = testProjectScope();
    authorizeTarget(scope);
    ptyMocks.state = 'idle';
    delivery.initIdleDelivery();

    const systemHandoff = handoff({
      id: 'handoff-system',
      fromAgent: 'nexus-delegation-supervisor',
      status: 'progress',
      summary: 'Recuperação de orquestração (sistema Nexus)',
    });
    storeMocks.handoffs.set(systemHandoff.id, systemHandoff);
    delivery.onHandoffSubmitted(systemHandoff, scope);
    await vi.advanceTimersByTimeAsync(150);

    expect(ptyMocks.writes).toHaveBeenCalledWith(
      'orchestrator-session',
      expect.stringMatching(
        /from=nexus-delegation-supervisor.*claim_trust=system.*evidence=nexus_system/i,
      ),
      { markInputBusy: false },
    );
    expect(ptyMocks.writes.mock.calls[0][1]).not.toMatch(/claim_trust=untrusted/);
    delivery.shutdownIdleDelivery();
  });

  it('rechecks queued evidence and labels it stale after the workflow changes', async () => {
    const delivery = await import('./idle-delivery');
    const scope = testProjectScope();
    authorizeTarget(scope);
    delivery.initIdleDelivery();
    const trusted = handoff({
      evidenceIds: ['evidence-a'],
      evidenceTrust: 'nexus-trusted',
    });

    delivery.onHandoffSubmitted(trusted, scope);
    storeMocks.handoffs.set(
      trusted.id,
      handoff({
        evidenceIds: ['evidence-a'],
        evidenceTrust: 'stale',
      }),
    );
    ptyMocks.state = 'idle';
    ptyMocks.stateTaps[0]('orchestrator-session', 'idle');
    await vi.advanceTimersByTimeAsync(150);

    expect(ptyMocks.writes).toHaveBeenCalledWith(
      'orchestrator-session',
      expect.stringMatching(/evidence=stale.*does_not_complete_mission/i),
      { markInputBusy: false },
    );
    delivery.shutdownIdleDelivery();
  });

  it('cancels the stable-idle delivery before any write when the exact session exits', async () => {
    const delivery = await import('./idle-delivery');
    const scope = testProjectScope();
    authorizeTarget(scope);
    ptyMocks.state = 'idle';
    delivery.initIdleDelivery();
    const recovery = vi.fn(async () => true);
    delivery.configureHandoffDeliveryRuntimeRecovery(recovery);

    delivery.onHandoffSubmitted(handoff(), scope);
    ptyMocks.exitTaps[0]('orchestrator-session');
    await vi.advanceTimersByTimeAsync(200);

    expect(ptyMocks.writes).not.toHaveBeenCalled();
    expect(storeMocks.deliveryAttempts.size).toBe(0);
    expect(storeMocks.delivered).toEqual([]);
    expect(recovery).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'orchestrator-session',
        missionId: 'mission-a',
        handoffId: expect.any(String),
      }),
    );
    delivery.shutdownIdleDelivery();
  });

  it('marks submitted only after the TUI proves acceptance (session busy)', async () => {
    const delivery = await import('./idle-delivery');
    const scope = testProjectScope();
    authorizeTarget(scope);
    ptyMocks.state = 'idle';
    delivery.initIdleDelivery();

    delivery.onHandoffSubmitted(handoff(), scope);
    expect(storeMocks.delivered).toEqual([]);
    await advanceUntilSubmitted(delivery);

    expect(ptyMocks.writes).toHaveBeenLastCalledWith(
      'orchestrator-session',
      '\r',
      { markInputBusy: false },
    );
    // Sem prova de aceite (sessão segue idle — possível modal), nada é marcado.
    await vi.advanceTimersByTimeAsync(1_000);
    expect(storeMocks.delivered).toEqual([]);

    // Aceite: o evento busy é a prova, sem polling que possa perder a borda.
    ptyMocks.state = 'busy';
    ptyMocks.stateTaps[0]('orchestrator-session', 'busy');
    expect(storeMocks.delivered).toEqual([{ scope, id: 'handoff-a' }]);
    delivery.shutdownIdleDelivery();
  });

  it('does not treat unrelated busy activity before Enter as submit proof', async () => {
    const delivery = await import('./idle-delivery');
    const scope = testProjectScope();
    authorizeTarget(scope);
    ptyMocks.state = 'idle';
    delivery.initIdleDelivery();

    delivery.onHandoffSubmitted(handoff(), scope);
    ptyMocks.state = 'busy';
    ptyMocks.stateTaps[0]('orchestrator-session', 'busy');
    expect(storeMocks.delivered).toEqual([]);

    ptyMocks.state = 'idle';
    ptyMocks.stateTaps[0]('orchestrator-session', 'idle');
    await advanceUntilSubmitted(delivery);
    expect(ptyMocks.writes).toHaveBeenLastCalledWith(
      'orchestrator-session',
      '\r',
      { markInputBusy: false },
    );
    expect(storeMocks.delivered).toEqual([]);
    delivery.shutdownIdleDelivery();
  });

  it('settles the pasted handoff before Enter so paste flicker is not submit proof', async () => {
    const delivery = await import('./idle-delivery');
    const scope = testProjectScope();
    authorizeTarget(scope);
    ptyMocks.state = 'idle';
    delivery.initIdleDelivery();

    delivery.onHandoffSubmitted(handoff(), scope);
    await advanceUntilPasted(delivery);

    const pasteWrites = ptyMocks.writes.mock.calls.filter(([, data]) =>
      String(data).includes('handoff_id=handoff-a'),
    );
    expect(pasteWrites).toHaveLength(1);
    expect(String(pasteWrites[0]![1])).toMatch(/^\x1b\[200~/);
    expect(ptyMocks.writes.mock.calls.filter(([, data]) => data === '\r')).toHaveLength(0);

    ptyMocks.state = 'busy';
    ptyMocks.stateTaps[0]('orchestrator-session', 'busy');
    expect(storeMocks.delivered).toEqual([]);

    ptyMocks.state = 'idle';
    ptyMocks.stateTaps[0]('orchestrator-session', 'idle');
    await vi.advanceTimersByTimeAsync(delivery.HANDOFF_PROMPT_SETTLE_MS);
    expect(ptyMocks.writes.mock.calls.filter(([, data]) => data === '\r')).toHaveLength(1);

    ptyMocks.state = 'busy';
    ptyMocks.stateTaps[0]('orchestrator-session', 'busy');
    expect(storeMocks.delivered).toEqual([{ scope, id: 'handoff-a' }]);
    delivery.shutdownIdleDelivery();
  });

  describe('F-735: Codex só recebe o CR depois de ingerir a colagem', () => {
    // Forma do print do operador (02/10): handoff de ~4,5 mil caracteres para
    // um Maestro Codex. O CR de 500 ms caía no meio da ingestão e virava
    // quebra de linha dentro da colagem; cada nova tentativa colava outra cópia.
    const bigHandoff = () => {
      const big = handoff({ summary: 'resultado conferido '.repeat(200) });
      storeMocks.handoffs.set(big.id, big);
      return big;
    };
    const crs = () => ptyMocks.writes.mock.calls.filter(([, data]) => data === '\r');
    const emit = (data: string) => {
      for (const tap of [...ptyMocks.dataTaps]) tap('orchestrator-session', data);
    };

    it('segura o CR até o marcador [Pasted Content] e entrega depois dele', async () => {
      const delivery = await import('./idle-delivery');
      const { PASTE_INGEST_GRACE_MS, PASTE_QUIESCE_MS } = await import('./paste-ingest');
      const scope = testProjectScope();
      authorizeTarget(scope);
      ptyMocks.adapters.set('orchestrator-session', 'codex');
      ptyMocks.state = 'idle';
      delivery.initIdleDelivery();

      delivery.onHandoffSubmitted(bigHandoff(), scope);
      await advanceUntilPasted(delivery);
      expect(ptyMocks.writes.mock.calls.filter(([, data]) =>
        String(data).startsWith('\x1b[200~'))).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(crs()).toHaveLength(0);

      // O ratatui desenha os espaços com movimento de cursor.
      emit('\x1b[2;3H[Pasted\x1b[1CContent\x1b[1C4012\x1b[1Cchars]');
      await vi.advanceTimersByTimeAsync(PASTE_INGEST_GRACE_MS - 1);
      expect(crs()).toHaveLength(0);
      // F-1282: o marcador só vale com a saída quieta (PASTE_QUIESCE_MS) —
      // a ingestão pode ter mais blocos a caminho — antes da folga de sempre.
      await vi.advanceTimersByTimeAsync(PASTE_QUIESCE_MS + 1);
      expect(crs()).toHaveLength(1);

      ptyMocks.state = 'busy';
      ptyMocks.stateTaps[0]('orchestrator-session', 'busy');
      expect(storeMocks.delivered).toEqual([{ scope, id: 'handoff-a' }]);
      delivery.shutdownIdleDelivery();
    });

    it('F-1536: marcador com fração do texto (colagem picotada) NÃO recebe CR e a entrega não conta como feita', async () => {
      const delivery = await import('./idle-delivery');
      const { PASTE_INGEST_GRACE_MS, PASTE_QUIESCE_MS } = await import('./paste-ingest');
      const scope = testProjectScope();
      authorizeTarget(scope);
      ptyMocks.adapters.set('orchestrator-session', 'codex');
      ptyMocks.state = 'idle';
      delivery.initIdleDelivery();

      delivery.onHandoffSubmitted(bigHandoff(), scope);
      await advanceUntilPasted(delivery);

      // O ConPTY comeu o começo: a TUI aceitou 300 de ~4 mil caracteres.
      emit('[Pasted Content 300 chars]');
      await vi.advanceTimersByTimeAsync(PASTE_INGEST_GRACE_MS + PASTE_QUIESCE_MS + 5_000);
      expect(crs()).toHaveLength(0);
      expect(storeMocks.delivered).toEqual([]);
      delivery.shutdownIdleDelivery();
    });

    it('sem marcador, o CR sai no teto proporcional ao tamanho', async () => {
      const delivery = await import('./idle-delivery');
      const { pasteIngestCapMs } = await import('./paste-ingest');
      const scope = testProjectScope();
      authorizeTarget(scope);
      ptyMocks.adapters.set('orchestrator-session', 'codex');
      ptyMocks.state = 'idle';
      delivery.initIdleDelivery();

      delivery.onHandoffSubmitted(bigHandoff(), scope);
      await advanceUntilPasted(delivery);
      const pasted = ptyMocks.writes.mock.calls.find(([, data]) =>
        String(data).startsWith('\x1b[200~'))!;
      const payloadChars = String(pasted[1]).length - '\x1b[200~\x1b[201~'.length;
      const capMs = pasteIngestCapMs(payloadChars);
      await vi.advanceTimersByTimeAsync(capMs - 1);
      expect(crs()).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(10);
      expect(crs()).toHaveLength(1);
      delivery.shutdownIdleDelivery();
    });

    it('outras CLIs mantêm o CR de 500 ms mesmo com colagem grande', async () => {
      const delivery = await import('./idle-delivery');
      const scope = testProjectScope();
      authorizeTarget(scope);
      ptyMocks.adapters.set('orchestrator-session', 'claude');
      ptyMocks.state = 'idle';
      delivery.initIdleDelivery();

      delivery.onHandoffSubmitted(bigHandoff(), scope);
      await advanceUntilSubmitted(delivery);
      expect(crs()).toHaveLength(1);
      expect(ptyMocks.dataTaps).toHaveLength(0);
      delivery.shutdownIdleDelivery();
    });
  });

  it('refila idle transitório sem gastar tentativa nem recuperar um Maestro saudável', async () => {
    const delivery = await import('./idle-delivery');
    const scope = testProjectScope();
    const current = authorizeSchedulerOwnedHandoff(scope);
    const owner = { id: 101 };
    paneMocks.authorities.set('orchestrator-session', {
      owner,
      paneId: 'orchestrator-pane',
      sessionId: 'orchestrator-session',
      kind: 'cli-agent',
      missionId: 'mission-a',
      role: 'orchestrator',
      scope,
    });
    scopeMocks.scopesByOwner.set(owner.id, scope);
    const recover = vi.fn(async () => true);
    delivery.configureHandoffDeliveryRuntimeRecovery(recover);
    ptyMocks.state = 'idle';
    delivery.initIdleDelivery();

    delivery.onHandoffSubmitted(current, scope);
    ptyMocks.state = 'busy';
    ptyMocks.stateTaps[0]('orchestrator-session', 'busy');
    await vi.advanceTimersByTimeAsync(25_000);

    expect(storeMocks.deliveryAttempts.size).toBe(0);
    expect(ptyMocks.writes).not.toHaveBeenCalled();
    expect(recover).not.toHaveBeenCalled();

    ptyMocks.state = 'idle';
    ptyMocks.stateTaps[0]('orchestrator-session', 'idle');
    await advanceUntilSubmitted(delivery);

    expect([...storeMocks.deliveryAttempts.values()]).toEqual([
      expect.objectContaining({
        handoffId: current.id,
        attemptNo: 1,
        state: 'pasted',
      }),
    ]);
    expect(
      ptyMocks.writes.mock.calls.filter(([, data]) =>
        String(data).includes(`handoff_id=${current.id}`),
      ),
    ).toHaveLength(1);
    expect(
      ptyMocks.writes.mock.calls.filter(([, data]) => data === '\r'),
    ).toHaveLength(1);

    ptyMocks.state = 'busy';
    ptyMocks.stateTaps[0]('orchestrator-session', 'busy');
    expect(storeMocks.delivered).toEqual([{ scope, id: current.id }]);
    expect(storeMocks.consumed).toEqual([]);
    expect(recover).not.toHaveBeenCalled();
    delivery.shutdownIdleDelivery();
  });

  it('captures a fast busy→idle turn during the Enter retry window without duplicating', async () => {
    const delivery = await import('./idle-delivery');
    const scope = testProjectScope();
    authorizeTarget(scope);
    ptyMocks.state = 'idle';
    delivery.initIdleDelivery();

    delivery.onHandoffSubmitted(handoff(), scope);
    await advanceUntilSubmitted(delivery);
    expect(ptyMocks.writes.mock.calls.filter((call) => call[1] === '\r')).toHaveLength(1);

    // Turno curtíssimo: termina antes dos 400 ms do retry. O polling antigo
    // nunca via busy e reentregava o mesmo handoff.
    ptyMocks.state = 'busy';
    ptyMocks.stateTaps[0]('orchestrator-session', 'busy');
    ptyMocks.state = 'idle';
    ptyMocks.stateTaps[0]('orchestrator-session', 'idle');
    await vi.advanceTimersByTimeAsync(13_000);

    expect(storeMocks.delivered).toEqual([{ scope, id: 'handoff-a' }]);
    expect(ptyMocks.writes.mock.calls.filter((call) => call[1] === '\r')).toHaveLength(1);
    expect(
      ptyMocks.writes.mock.calls.filter((call) =>
        String(call[1]).includes('completed the requested work'),
      ),
    ).toHaveLength(1);
    delivery.shutdownIdleDelivery();
  });

  it('F-1006: dois handoffs no mesmo idle saem numa colagem só; o CR único é aceito por uma borda busy', async () => {
    const delivery = await import('./idle-delivery');
    const scope = testProjectScope();
    authorizeTarget(scope);
    ptyMocks.state = 'idle';
    delivery.initIdleDelivery();

    const first = handoff({ id: 'handoff-first', summary: 'primeira entrega completa' });
    const second = handoff({ id: 'handoff-second', summary: 'segunda entrega completa' });
    storeMocks.handoffs.set(first.id, first);
    storeMocks.handoffs.set(second.id, second);
    delivery.onHandoffSubmitted(first, scope);
    delivery.onHandoffSubmitted(second, scope);
    await advanceUntilSubmitted(delivery);

    const pastes = ptyMocks.writes.mock.calls.filter((call) =>
      String(call[1]).includes('handoff_id=handoff-'),
    );
    expect(pastes).toHaveLength(1);
    expect(String(pastes[0]![1])).toContain('handoff_id=handoff-first');
    expect(String(pastes[0]![1])).toContain('handoff_id=handoff-second');
    // Uma linha só: nenhum LF dentro da colagem vira Enter num TUI.
    expect(String(pastes[0]![1])).not.toMatch(/[\r\n]/);
    expect(ptyMocks.writes.mock.calls.filter((call) => call[1] === '\r')).toHaveLength(1);
    // Antes da borda busy nada é entregue.
    expect(storeMocks.delivered).toEqual([]);
    ptyMocks.state = 'busy';
    ptyMocks.stateTaps[0]('orchestrator-session', 'busy');
    expect(storeMocks.delivered).toEqual([
      { scope, id: 'handoff-first' },
      { scope, id: 'handoff-second' },
    ]);
    // Exatamente-uma-vez: uma tentativa aceita por handoff.
    expect([...storeMocks.deliveryAttempts.values()].map((attempt) => [attempt.handoffId, attempt.state]))
      .toEqual([['handoff-first', 'accepted'], ['handoff-second', 'accepted']]);
    delivery.shutdownIdleDelivery();
  });

  it('F-1006: rajada que chega com o Maestro ocupado sai inteira na próxima borda ociosa', async () => {
    const delivery = await import('./idle-delivery');
    const scope = testProjectScope();
    authorizeTarget(scope);
    ptyMocks.state = 'idle';
    delivery.initIdleDelivery();
    const pastesWith = (id: string) => ptyMocks.writes.mock.calls.filter((call) =>
      String(call[1]).includes(`handoff_id=${id} `),
    ).length;

    const lead = handoff({ id: 'handoff-lead', summary: 'primeira' });
    storeMocks.handoffs.set(lead.id, lead);
    delivery.onHandoffSubmitted(lead, scope);
    await advanceUntilSubmitted(delivery);
    ptyMocks.state = 'busy';
    ptyMocks.stateTaps[0]('orchestrator-session', 'busy');

    const burst = ['handoff-b1', 'handoff-b2', 'handoff-b3', 'handoff-b4', 'handoff-b5']
      .map((id) => handoff({ id, summary: `payload ${id}` }));
    for (const item of burst) {
      storeMocks.handoffs.set(item.id, item);
      delivery.onHandoffSubmitted(item, scope);
    }
    // Ocupado: nada cola por cima do turno.
    expect(burst.map((item) => pastesWith(item.id))).toEqual([0, 0, 0, 0, 0]);

    ptyMocks.state = 'idle';
    ptyMocks.stateTaps[0]('orchestrator-session', 'idle');
    await advanceUntilSubmitted(delivery);
    const deliveryPastes = ptyMocks.writes.mock.calls.filter((call) =>
      String(call[1]).includes('[nexus handoff delivery_metadata]'),
    );
    expect(deliveryPastes).toHaveLength(2);
    expect(burst.map((item) => pastesWith(item.id))).toEqual([1, 1, 1, 1, 1]);
    ptyMocks.state = 'busy';
    ptyMocks.stateTaps[0]('orchestrator-session', 'busy');
    expect(storeMocks.delivered.map((entry) => entry.id)).toEqual([
      'handoff-lead', ...burst.map((item) => item.id),
    ]);
    const attempts = [...storeMocks.deliveryAttempts.values()];
    expect(attempts).toHaveLength(6);
    expect(attempts.every((attempt) => attempt.state === 'accepted')).toBe(true);
    delivery.shutdownIdleDelivery();
  });

  it('F-1006: ACK do Maestro antes da borda busy (CAS perdido) não lança no tap nem prende a fila', async () => {
    const delivery = await import('./idle-delivery');
    const scope = testProjectScope();
    authorizeTarget(scope);
    storeMocks.strictAcceptCas = true;
    ptyMocks.state = 'idle';
    delivery.initIdleDelivery();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const first = handoff({ id: 'handoff-first', summary: 'primeira' });
    storeMocks.handoffs.set(first.id, first);
    delivery.onHandoffSubmitted(first, scope);
    await advanceUntilSubmitted(delivery);
    // O Maestro leu a colagem e deu nexus_handoff_ack (pull) antes de o TUI
    // pintar busy: o ledger já saiu de `queued`.
    storeMocks.handoffs.set(first.id, { ...first, delivered: true, deliveryState: 'consumed' });
    ptyMocks.state = 'busy';
    const second = handoff({ id: 'handoff-second', summary: 'segunda' });
    storeMocks.handoffs.set(second.id, second);
    delivery.onHandoffSubmitted(second, scope);

    expect(() => ptyMocks.stateTaps[0]('orchestrator-session', 'busy')).not.toThrow();
    // A tentativa colada foi resolvida pelo ledger (sem segunda colagem).
    expect([...storeMocks.deliveryAttempts.values()]
      .filter((attempt) => attempt.handoffId === first.id)
      .map((attempt) => attempt.state)).toEqual(['failed']);

    // A fila anda na próxima borda ociosa, sem esperar o prazo de aceite (12 s).
    ptyMocks.state = 'idle';
    ptyMocks.stateTaps[0]('orchestrator-session', 'idle');
    await advanceUntilSubmitted(delivery);
    expect(ptyMocks.writes.mock.calls.filter((call) =>
      String(call[1]).includes('handoff_id=handoff-second'),
    )).toHaveLength(1);
    ptyMocks.state = 'busy';
    ptyMocks.stateTaps[0]('orchestrator-session', 'busy');
    expect(storeMocks.delivered.map((entry) => entry.id)).toEqual(['handoff-second']);
    expect(ptyMocks.writes.mock.calls.filter((call) =>
      String(call[1]).includes('handoff_id=handoff-first'),
    )).toHaveLength(1);
    warn.mockRestore();
    delivery.shutdownIdleDelivery();
  });

  it('F-1006: idle de writer em worktree verifica a conclusão no escopo de COORDENAÇÃO', async () => {
    const delivery = await import('./idle-delivery');
    const scope = testProjectScope();
    const executionScope = testProjectScope({ rootRealPath: '/workspace/.nexus-worktrees/writer-1' });
    paneMocks.authorities.set('writer-session', {
      owner: null,
      paneId: 'writer-pane',
      sessionId: 'writer-session',
      kind: 'cli-agent',
      missionId: 'mission-a',
      role: 'worker',
      scope,
      executionScope,
    });
    delivery.initIdleDelivery();
    ptyMocks.stateTaps[0]('writer-session', 'idle');
    expect(civilianMocks.maybeComplete).toHaveBeenCalledWith(scope, 'mission-a');
    expect(civilianMocks.maybeComplete.mock.calls.every(([requested]) =>
      (requested as ProjectExecutionScope).rootRealPath === scope.rootRealPath)).toBe(true);
    delivery.shutdownIdleDelivery();
  });

  it('F-1007: idle do Maestro que pediu done reverifica a conclusão; sem pedido, não', async () => {
    const delivery = await import('./idle-delivery');
    const { recordOperatorTabCompletionRequest } = await import('./operator-tab-completion');
    const scope = testProjectScope();
    authorizeMainOwnedTarget(scope);
    delivery.initIdleDelivery();
    ptyMocks.state = 'idle';
    ptyMocks.stateTaps[0]('orchestrator-session', 'idle');
    expect(civilianMocks.maybeComplete).not.toHaveBeenCalled();

    const mission = storeMocks.missions.get(`${scope.projectId}:${scope.checkoutId}:mission-a`)!;
    recordOperatorTabCompletionRequest(scope, mission as Parameters<typeof recordOperatorTabCompletionRequest>[1]);
    ptyMocks.stateTaps[0]('orchestrator-session', 'idle');
    expect(civilianMocks.maybeComplete).toHaveBeenCalledWith(scope, 'mission-a');

    // Pedido de outro líder não vale para o Maestro corrente.
    civilianMocks.maybeComplete.mockClear();
    storeMocks.missions.set(`${scope.projectId}:${scope.checkoutId}:mission-a`, { ...mission, orchestratorSessionId: 'new-leader' });
    ptyMocks.stateTaps[0]('orchestrator-session', 'idle');
    expect(civilianMocks.maybeComplete).not.toHaveBeenCalled();
    delivery.shutdownIdleDelivery();
  });

  it('recupera todas as filas quando a mesma sessão é rebindada entre missões', async () => {
    const delivery = await import('./idle-delivery');
    const scope = testProjectScope();
    const owner = { id: 101 };
    authorizeTarget(scope, owner);
    const first = handoff({
      id: 'handoff-old-mission',
      missionId: 'mission-a',
    });
    storeMocks.handoffs.set(first.id, first);
    const recover = vi.fn(async () => true);
    delivery.configureHandoffDeliveryRuntimeRecovery(recover);
    delivery.initIdleDelivery();

    delivery.onHandoffSubmitted(first, scope);

    storeMocks.missions.set(
      `${scope.projectId}:${scope.checkoutId}:mission-b`,
      {
        id: 'mission-b',
        orchestratorSessionId: 'orchestrator-session',
        status: 'running',
        description: 'Nova missão após rebind',
      },
    );
    paneMocks.authorities.set('orchestrator-session', {
      owner,
      paneId: 'orchestrator-pane',
      sessionId: 'orchestrator-session',
      kind: 'cli-agent',
      missionId: 'mission-b',
      role: 'orchestrator',
      scope,
    });
    const second = handoff({
      id: 'handoff-new-mission',
      missionId: 'mission-b',
    });
    storeMocks.handoffs.set(second.id, second);
    delivery.onHandoffSubmitted(second, scope);

    ptyMocks.state = 'idle';
    ptyMocks.stateTaps[0]('orchestrator-session', 'idle');
    await Promise.resolve();

    expect(ptyMocks.writes).not.toHaveBeenCalled();
    expect(storeMocks.deliveryAttempts.size).toBe(0);
    expect(recover).toHaveBeenCalledTimes(2);
    expect(recover).toHaveBeenCalledWith({
      scope,
      missionId: 'mission-a',
      sessionId: 'orchestrator-session',
      paneId: 'orchestrator-pane',
      handoffId: first.id,
    });
    expect(recover).toHaveBeenCalledWith({
      scope,
      missionId: 'mission-b',
      sessionId: 'orchestrator-session',
      paneId: 'orchestrator-pane',
      handoffId: second.id,
    });
    delivery.shutdownIdleDelivery();
  });

  it('requeues once a handoff swallowed without acceptance instead of losing it', async () => {
    const delivery = await import('./idle-delivery');
    const scope = testProjectScope();
    authorizeTarget(scope);
    ptyMocks.state = 'idle';
    delivery.initIdleDelivery();

    delivery.onHandoffSubmitted(handoff(), scope);
    await vi.advanceTimersByTimeAsync(150);
    const deliveries = () =>
      ptyMocks.writes.mock.calls.filter((call) =>
        String(call[1]).includes('completed the requested work'),
      );
    expect(deliveries()).toHaveLength(1);

    // Janela de aceite estoura sem busy: não marca submitted. O retry 2
    // espera o backoff de F-112 (15s) antes de recolar — nada de retry no
    // mesmo segundo contra o mesmo PTY.
    await vi.advanceTimersByTimeAsync(13_000);
    expect(storeMocks.delivered).toEqual([]);
    expect(deliveries()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(
      delivery.HANDOFF_DELIVERY_RETRY_BACKOFF_MS,
    );
    expect(deliveries()).toHaveLength(2);
    delivery.shutdownIdleDelivery();
  });

  it('persists paste write failure and consumes the bounded retry instead of losing the handoff', async () => {
    const delivery = await import('./idle-delivery');
    const scope = testProjectScope();
    authorizeTarget(scope);
    ptyMocks.state = 'idle';
    ptyMocks.writes.mockImplementationOnce(() => false).mockReturnValue(true);
    delivery.initIdleDelivery();

    delivery.onHandoffSubmitted(handoff(), scope);
    await advanceUntilPasted(delivery);
    // A tentativa 2 só cola depois do backoff de F-112.
    await vi.advanceTimersByTimeAsync(
      delivery.HANDOFF_DELIVERY_RETRY_BACKOFF_MS,
    );
    await advanceUntilPasted(delivery);
    await advanceUntilSubmitted(delivery);

    const attempts = [...storeMocks.deliveryAttempts.values()];
    expect(attempts).toHaveLength(2);
    expect(attempts[0]).toMatchObject({ attemptNo: 1, state: 'failed' });
    expect(attempts[1]).toMatchObject({ attemptNo: 2, state: 'pasted' });
    expect(ptyMocks.writes.mock.calls.filter((call) =>
      String(call[1]).includes('handoff_id=handoff-a'),
    )).toHaveLength(2);

    ptyMocks.state = 'busy';
    ptyMocks.stateTaps[0]('orchestrator-session', 'busy');
    expect(storeMocks.delivered).toEqual([{ scope, id: 'handoff-a' }]);
    delivery.shutdownIdleDelivery();
  });

  it('persists Enter write failure and requeues once before accepting the second attempt', async () => {
    const delivery = await import('./idle-delivery');
    const scope = testProjectScope();
    authorizeTarget(scope);
    ptyMocks.state = 'idle';
    let enterWrites = 0;
    ptyMocks.writes.mockImplementation((_sessionId, data) => {
      if (data !== '\r') return true;
      enterWrites += 1;
      return enterWrites > 1;
    });
    delivery.initIdleDelivery();

    delivery.onHandoffSubmitted(handoff(), scope);
    await advanceUntilSubmitted(delivery);
    // O Enter falhou na tentativa 1; a tentativa 2 espera o backoff de F-112.
    await vi.advanceTimersByTimeAsync(
      delivery.HANDOFF_DELIVERY_RETRY_BACKOFF_MS,
    );
    await advanceUntilSubmitted(delivery);

    const attempts = [...storeMocks.deliveryAttempts.values()];
    expect(attempts).toHaveLength(2);
    expect(attempts[0]).toMatchObject({ attemptNo: 1, state: 'failed' });
    expect(attempts[1]).toMatchObject({ attemptNo: 2, state: 'pasted' });
    ptyMocks.state = 'busy';
    ptyMocks.stateTaps[0]('orchestrator-session', 'busy');
    expect(storeMocks.delivered).toEqual([{ scope, id: 'handoff-a' }]);
    delivery.shutdownIdleDelivery();
  }, 20_000);

  it('NUNCA bloqueia a missão por entrega não aceita — pede recuperação de runtime (doutrina Overclock)', async () => {
    const delivery = await import('./idle-delivery');
    const scope = testProjectScope();
    authorizeTarget(scope);
    const current = handoff();
    storeMocks.handoffs.set(current.id, current);
    const recovery = vi.fn(async () => true);
    delivery.configureHandoffDeliveryRuntimeRecovery(recovery);
    ptyMocks.state = 'idle';
    delivery.initIdleDelivery();

    delivery.onHandoffSubmitted(current, scope);
    await vi.advanceTimersByTimeAsync(30_000);

    const deliveries = ptyMocks.writes.mock.calls.filter((call) =>
      String(call[1]).includes('completed the requested work'),
    );
    // O número de colagens depende de MAX_HANDOFF_DELIVERY_ATTEMPTS: quanto
    // mais tentativas permitidas, mais entrega tenta antes de pedir runtime.
    expect(deliveries.length).toBeGreaterThanOrEqual(2);
    expect(storeMocks.delivered).toEqual([]);
    // A missão segue viva: nenhum update de status/description, nenhum
    // marcador de "handoff não entregue" (o toast que mente vem daqui).
    expect(storeMocks.missionUpdates).toEqual([]);
    expect(
      storeMocks.missions.get(`${scope.projectId}:${scope.checkoutId}:mission-a`)
        ?.status,
    ).toBe('running');
    expect(storeMocks.handoffs.get('handoff-a')?.deliveryState).toBe('queued');
    // PTY still idle = modal, not a dead Maestro. Recovery would drop
    // orchestratorSessionId (DEV 25/08).
    expect(recovery).not.toHaveBeenCalled();
    delivery.shutdownIdleDelivery();
  });

  it('F-925: orçamento esgotado com Maestro idle não vira wedge — o re-drive periódico recola', async () => {
    const delivery = await import('./idle-delivery');
    const scope = testProjectScope();
    authorizeTarget(scope);
    const current = handoff();
    storeMocks.handoffs.set(current.id, current);
    const recovery = vi.fn(async () => true);
    delivery.configureHandoffDeliveryRuntimeRecovery(recovery);
    ptyMocks.state = 'idle';
    delivery.initIdleDelivery();

    delivery.onHandoffSubmitted(current, scope);
    const deliveries = () =>
      ptyMocks.writes.mock.calls.filter((call) =>
        String(call[1]).includes('completed the requested work'),
      );

    // 3 tentativas morrem de accept_timeout (backoffs de 15s e 30s, F-112).
    // Campo 05/10: a partir daqui a missão ficou 119 min parada — Maestro
    // vivo no prompt (modal?), workers mortos, zero pastes novos.
    await vi.advanceTimersByTimeAsync(85_000);
    expect(deliveries()).toHaveLength(3);
    expect(storeMocks.delivered).toEqual([]);
    expect(recovery).not.toHaveBeenCalled();

    // O re-drive periódico (outbox 1s / caixa durável / re-arm do supervisor)
    // re-submete o handoff queued. A liberação das falhas reabre o orçamento,
    // MAS atrás de uma espera crescente — sem ela o laço recolava a cada
    // ~13 s para sempre (revisão de 793aa40ca: 546 colagens em 119 min).
    expect(delivery.redeliverPendingHandoffs(scope, 'mission-a')).toBe(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(deliveries()).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(
      delivery.IDLE_RELEASE_RETRY_BASE_MS + 2_000,
    );
    expect(deliveries()).toHaveLength(4);
    expect(storeMocks.delivered).toEqual([]);

    // Quando o modal solta o turno, a borda busy aceita a entrega normal.
    ptyMocks.state = 'busy';
    ptyMocks.stateTaps[0]('orchestrator-session', 'busy');
    expect(storeMocks.delivered).toEqual([{ scope, id: 'handoff-a' }]);
    expect(
      storeMocks.missions.get(`${scope.projectId}:${scope.checkoutId}:mission-a`)
        ?.status,
    ).toBe('running');
    delivery.shutdownIdleDelivery();
  });

  it('F-925 revisão: com o outbox de 1 s ligado, 119 min produzem poucas colagens (O(log)+teto), e a entrega acontece quando o Maestro aceita', async () => {
    const delivery = await import('./idle-delivery');
    const scope = testProjectScope();
    authorizeTarget(scope);
    const current = handoff();
    storeMocks.handoffs.set(current.id, current);
    const recovery = vi.fn(async () => true);
    delivery.configureHandoffDeliveryRuntimeRecovery(recovery);
    ptyMocks.state = 'idle';
    delivery.initIdleDelivery();

    delivery.onHandoffSubmitted(current, scope);
    const pastes = () =>
      ptyMocks.writes.mock.calls.filter((call) =>
        String(call[1]).includes('completed the requested work'),
      ).length;
    const enters = () =>
      ptyMocks.writes.mock.calls.filter(
        (call) => call[1] === '\r' || call[1] === '\r\n',
      ).length;

    // O incidente real: outbox de 1 s recolando contra um Maestro ocioso.
    // Sem a espera crescente foram 546 colagens e 2184 Enters em 119 min.
    for (let tick = 0; tick < 119 * 60; tick += 1) {
      await vi.advanceTimersByTimeAsync(1_000);
      delivery.redeliverPendingHandoffs(scope, 'mission-a');
    }

    // O orçamento continua reabrindo (não é o wedge original), mas cada
    // rodada dobra a espera por handoff+sessão até o teto — e a sexta
    // rodada liberada sem aceite ESTACIONA a entrega (delivery-needs-
    // operator). 119 min = 3 tentativas F-112 + 6 rodadas + teto.
    expect(pastes()).toBeGreaterThan(3);
    expect(pastes()).toBeLessThanOrEqual(14);
    expect(enters()).toBeLessThanOrEqual(56);
    expect(missionEventMocks.emitMissionEvent).toHaveBeenCalledWith(
      scope,
      expect.objectContaining({
        missionId: 'mission-a',
        type: 'custom',
        origin: 'system',
        payload: expect.objectContaining({
          kind: 'delivery-needs-operator',
          handoffId: 'handoff-a',
        }),
      }),
    );
    expect(recovery).not.toHaveBeenCalled();
    expect(storeMocks.handoffs.get('handoff-a')?.deliveryState).toBe('queued');
    expect(
      storeMocks.missions.get(`${scope.projectId}:${scope.checkoutId}:mission-a`)
        ?.status,
    ).toBe('running');

    // O Maestro acorda: a borda busy marca a espera, e depois da base da
    // rodada a borda idle dispara a recolagem represada na hora — a entrega
    // não espera o teto nem vira wedge de novo.
    ptyMocks.state = 'busy';
    ptyMocks.stateTaps[0]('orchestrator-session', 'busy');
    await vi.advanceTimersByTimeAsync(
      delivery.IDLE_RELEASE_RETRY_BASE_MS + 1_000,
    );
    ptyMocks.state = 'idle';
    ptyMocks.stateTaps[0]('orchestrator-session', 'idle');
    await advanceUntilSubmitted(delivery);
    ptyMocks.state = 'busy';
    ptyMocks.stateTaps[0]('orchestrator-session', 'busy');
    expect(storeMocks.delivered).toEqual([{ scope, id: 'handoff-a' }]);
    delivery.shutdownIdleDelivery();
  }, 120_000);

  it('F-925 revisão: borda busy→idle real dispara a rodada represada; re-publicar idle sem borda não', async () => {
    const delivery = await import('./idle-delivery');
    const scope = testProjectScope();
    authorizeTarget(scope);
    const current = handoff();
    storeMocks.handoffs.set(current.id, current);
    ptyMocks.state = 'idle';
    delivery.initIdleDelivery();

    delivery.onHandoffSubmitted(current, scope);
    const deliveries = () =>
      ptyMocks.writes.mock.calls.filter((call) =>
        String(call[1]).includes('completed the requested work'),
      );

    // 3 tentativas morrem de accept_timeout; a 4ª vem da liberação + espera
    // de 1 min e falha do mesmo jeito → rodada seguinte espera 2 min.
    await vi.advanceTimersByTimeAsync(160_000);
    expect(deliveries()).toHaveLength(4);
    expect(storeMocks.delivered).toEqual([]);

    // Idle re-publicado sem borda busy não é prova de mudança no PTY.
    ptyMocks.stateTaps[0]('orchestrator-session', 'idle');
    await vi.advanceTimersByTimeAsync(2_000);
    expect(deliveries()).toHaveLength(4);

    // Borda busy→idle depois da base da rodada dispara a recolagem na hora,
    // sem esperar a janela de 2 min terminar.
    ptyMocks.state = 'busy';
    ptyMocks.stateTaps[0]('orchestrator-session', 'busy');
    await vi.advanceTimersByTimeAsync(
      delivery.IDLE_RELEASE_RETRY_BASE_MS + 1_000,
    );
    ptyMocks.state = 'idle';
    ptyMocks.stateTaps[0]('orchestrator-session', 'idle');
    await advanceUntilPasted(delivery);
    expect(deliveries()).toHaveLength(5);
    delivery.shutdownIdleDelivery();
  });

  it('F-925 revisão: a espera represada de A não prende a fila — B cola na taxa da sessão', async () => {
    const delivery = await import('./idle-delivery');
    const scope = testProjectScope();
    authorizeTarget(scope);
    const a = handoff({ id: 'handoff-a', summary: 'payload de A' });
    const b = handoff({ id: 'handoff-b', summary: 'payload de B' });
    storeMocks.handoffs.set(a.id, a);
    ptyMocks.state = 'idle';
    delivery.initIdleDelivery();
    const pastesOf = (text: string) =>
      ptyMocks.writes.mock.calls.filter((call) =>
        String(call[1]).includes(text),
      ).length;

    delivery.onHandoffSubmitted(a, scope);
    // 3 tentativas de A morrem de accept_timeout (~13 s cada + backoffs F-112
    // de 15/30 s): a liberação arma a espera crescente de 60 s para A.
    await vi.advanceTimersByTimeAsync(85_000);
    expect(pastesOf('payload de A')).toBe(3);

    // B chega com A represado: não herda a escada de A — só a taxa da sessão
    // (janela base de 60 s desde a última colagem de A, ~72 s atrás).
    storeMocks.handoffs.set(b.id, b);
    delivery.onHandoffSubmitted(b, scope);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(pastesOf('payload de B')).toBe(0);
    // A espera de A (60 s a partir de ~84 s → ~144 s) ainda não venceu quando
    // o gate da sessão abre (~132 s): B cola ANTES do próximo round de A.
    await vi.advanceTimersByTimeAsync(30_000);
    expect(pastesOf('payload de B')).toBe(1);
    expect(pastesOf('payload de A')).toBe(3);

    // O aceite de B não adianta A: a borda busy→idle dentro da base da
    // rodada não dispara a espera represada.
    ptyMocks.state = 'busy';
    ptyMocks.stateTaps[0]('orchestrator-session', 'busy');
    expect(storeMocks.delivered).toEqual([{ scope, id: 'handoff-b' }]);
    ptyMocks.state = 'idle';
    ptyMocks.stateTaps[0]('orchestrator-session', 'idle');
    await vi.advanceTimersByTimeAsync(5_000);
    expect(pastesOf('payload de A')).toBe(3);

    // Na janela da própria escada, A volta a colar normalmente.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(pastesOf('payload de A')).toBe(4);
    delivery.shutdownIdleDelivery();
  });

  it('F-925 revisão: a sexta rodada estaciona com aviso e a borda busy→idle retoma na hora', async () => {
    const delivery = await import('./idle-delivery');
    const scope = testProjectScope();
    authorizeTarget(scope);
    const current = handoff();
    storeMocks.handoffs.set(current.id, current);
    const recovery = vi.fn(async () => true);
    delivery.configureHandoffDeliveryRuntimeRecovery(recovery);
    ptyMocks.state = 'idle';
    delivery.initIdleDelivery();
    const pastes = () =>
      ptyMocks.writes.mock.calls.filter((call) =>
        String(call[1]).includes('completed the requested work'),
      ).length;

    delivery.onHandoffSubmitted(current, scope);
    // 3 tentativas F-112 + 6 rodadas liberadas (esperas de 1/2/4/8/15/15 min)
    // sem aceite: ~48 min de relógio, depois a entrega ESTACIONA.
    await vi.advanceTimersByTimeAsync(50 * 60_000);
    expect(pastes()).toBe(3 + delivery.IDLE_RELEASE_PARK_ROUNDS);
    expect(missionEventMocks.emitMissionEvent).toHaveBeenCalledWith(
      scope,
      expect.objectContaining({
        missionId: 'mission-a',
        type: 'custom',
        origin: 'system',
        payload: expect.objectContaining({
          kind: 'delivery-needs-operator',
          handoffId: 'handoff-a',
          sessionId: 'orchestrator-session',
        }),
      }),
    );
    expect(recovery).not.toHaveBeenCalled();
    expect(storeMocks.handoffs.get('handoff-a')?.deliveryState).toBe('queued');
    expect(
      storeMocks.missions.get(`${scope.projectId}:${scope.checkoutId}:mission-a`)
        ?.status,
    ).toBe('running');

    // Sem o sweep do supervisor, outbox, caixa durável e re-publish de idle
    // não reabrem o parque — 30 min parados de verdade.
    delivery.redeliverPendingHandoffs(scope, 'mission-a');
    ptyMocks.stateTaps[0]('orchestrator-session', 'idle');
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(pastes()).toBe(3 + delivery.IDLE_RELEASE_PARK_ROUNDS);
    expect(storeMocks.delivered).toEqual([]);

    // Prova de mudança: a borda busy→idle real dispara a espera estacionada
    // (earliestFireAt=0 — nem a base precisa passar), libera as falhas e
    // recola; o busy seguinte é o aceite normal.
    ptyMocks.state = 'busy';
    ptyMocks.stateTaps[0]('orchestrator-session', 'busy');
    ptyMocks.state = 'idle';
    ptyMocks.stateTaps[0]('orchestrator-session', 'idle');
    await advanceUntilSubmitted(delivery);
    expect(pastes()).toBe(3 + delivery.IDLE_RELEASE_PARK_ROUNDS + 1);
    ptyMocks.state = 'busy';
    ptyMocks.stateTaps[0]('orchestrator-session', 'busy');
    expect(storeMocks.delivered).toEqual([{ scope, id: 'handoff-a' }]);
    delivery.shutdownIdleDelivery();
  });

  it('entrega estacionada volta à fila no sweep depois do TTL, sem repetir aviso', async () => {
    const delivery = await import('./idle-delivery');
    const scope = testProjectScope();
    authorizeTarget(scope);
    const current = handoff();
    storeMocks.handoffs.set(current.id, current);
    ptyMocks.state = 'idle';
    delivery.initIdleDelivery();
    const pastes = () =>
      ptyMocks.writes.mock.calls.filter((call) =>
        String(call[1]).includes('completed the requested work'),
      ).length;
    const parkEventKeys = () => {
      const calls = missionEventMocks.emitMissionEvent.mock.calls as unknown as Array<
        Parameters<typeof import('./mission-event-emit').emitMissionEvent>
      >;
      return calls
        .filter(([, event]) => event.payload?.kind === 'delivery-needs-operator')
        .map(([, event]) => event.idempotencyKey);
    };

    delivery.onHandoffSubmitted(current, scope);
    await vi.advanceTimersByTimeAsync(50 * 60_000);
    const parkedPastes = 3 + delivery.IDLE_RELEASE_PARK_ROUNDS;
    expect(pastes()).toBe(parkedPastes);
    expect(parkEventKeys()).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(delivery.IDLE_RELEASE_RETRY_MAX_MS);
    expect(pastes()).toBe(parkedPastes);
    delivery.redeliverPendingHandoffs(
      scope,
      'mission-a',
      undefined,
      { requeueExpiredParks: true },
    );
    await advanceUntilPasted(delivery);
    expect(pastes()).toBe(parkedPastes + 1);

    await vi.advanceTimersByTimeAsync(
      delivery.HANDOFF_PROMPT_SETTLE_MS + delivery.SUBMIT_ACCEPTANCE_WINDOW_MS + 1_000,
    );
    expect(parkEventKeys()).toHaveLength(2);
    expect(new Set(parkEventKeys())).toHaveProperty('size', 1);
    delivery.shutdownIdleDelivery();
  });

  it('F-925 revisão: sessão nova (rebind) não herda a escada — volta ao backoff F-112 com as tentativas dela', async () => {
    const delivery = await import('./idle-delivery');
    const scope = testProjectScope();
    authorizeTarget(scope);
    const current = handoff();
    storeMocks.handoffs.set(current.id, current);
    ptyMocks.state = 'idle';
    delivery.initIdleDelivery();
    const pastes = () =>
      ptyMocks.writes.mock.calls.filter((call) =>
        String(call[1]).includes('completed the requested work'),
      ).length;

    delivery.onHandoffSubmitted(current, scope);
    // 3 falhas da sessão antiga → liberação + escada de 60 s armada.
    await vi.advanceTimersByTimeAsync(85_000);
    expect(pastes()).toBe(3);

    // O Maestro sai e renasce com OUTRA sessão: as esperas da antiga morrem
    // com ela e a autoridade nova não tem tentativa nenhuma.
    ptyMocks.exitTaps.forEach((tap) => tap('orchestrator-session'));
    paneMocks.authorities.delete('orchestrator-session');
    paneMocks.authorities.set('orchestrator-session-2', {
      owner: { id: 101 },
      paneId: 'orchestrator-pane',
      sessionId: 'orchestrator-session-2',
      kind: 'cli-agent',
      missionId: 'mission-a',
      role: 'orchestrator',
      scope,
    });
    storeMocks.missions.set(`${scope.projectId}:${scope.checkoutId}:mission-a`, {
      id: 'mission-a',
      orchestratorSessionId: 'orchestrator-session-2',
      status: 'running',
      description: 'Objetivo original',
    });

    // Cola na hora (sem espera herdada) a partir do replay durável.
    expect(delivery.redeliverPendingHandoffs(scope, 'mission-a')).toBe(1);
    await advanceUntilPasted(delivery);
    expect(pastes()).toBe(4);
    expect(
      ptyMocks.writes.mock.calls.filter(
        (call) =>
          call[0] === 'orchestrator-session-2' &&
          String(call[1]).includes('completed the requested work'),
      ),
    ).toHaveLength(1);

    // O accept_timeout da sessão nova conta na escada DELA (F-112: 15 s),
    // não na escada de 60 s+ que a sessão anterior tinha armado.
    await vi.advanceTimersByTimeAsync(26_000);
    expect(pastes()).toBe(4);
    await vi.advanceTimersByTimeAsync(4_000);
    expect(pastes()).toBe(5);
    delivery.shutdownIdleDelivery();
  });

  it('mantém o handoff na fila quando o pane do Maestro morreu, sem fabricar aceite ou ACK', async () => {
    const delivery = await import('./idle-delivery');
    const scope = testProjectScope();
    const current = authorizeSchedulerOwnedHandoff(scope);
    ptyMocks.state = 'idle';
    delivery.initIdleDelivery();

    delivery.onHandoffSubmitted(current, scope);
    await vi.advanceTimersByTimeAsync(25_000);

    expect(storeMocks.delivered).toEqual([]);
    expect(storeMocks.consumed).toEqual([]);
    expect(storeMocks.handoffs.get('handoff-a')?.deliveryState).toBe('queued');
    expect(ptyMocks.writes).not.toHaveBeenCalled();
    expect(storeMocks.missionUpdates).toEqual([]);
    expect(
      storeMocks.missions.get(`${scope.projectId}:${scope.checkoutId}:mission-a`)
        ?.status,
    ).toBe('running');
    delivery.shutdownIdleDelivery();
  });

  it('ignora handoff diagnóstico do mission-driver e não bloqueia a missão', async () => {
    const delivery = await import('./idle-delivery');
    const scope = testProjectScope();
    authorizeTarget(scope);
    storeMocks.taskDispatches.push({
      handoffId: 'handoff-worker',
      missionId: 'mission-a',
      state: 'completed',
      executionMode: 'read_only',
      ownership: { files: [], symbols: [], domains: [] },
    });
    ptyMocks.state = 'idle';
    delivery.initIdleDelivery();

    delivery.onHandoffSubmitted(
      handoff({
        id: 'handoff-driver',
        fromAgent: 'nexus-mission-driver',
        status: 'stalled',
        summary: 'mission-driver: missão sem progresso há 10 min',
      }),
      scope,
    );
    await vi.advanceTimersByTimeAsync(25_000);

    expect(ptyMocks.writes).not.toHaveBeenCalled();
    expect(storeMocks.missionUpdates).toEqual([]);
    expect(
      storeMocks.missions.get(`${scope.projectId}:${scope.checkoutId}:mission-a`)
        ?.status,
    ).toBe('running');
    delivery.shutdownIdleDelivery();
  });

  it('F-727: entrega ao Maestro o [travado] do supervisor (F-242) sem bloquear a missão', async () => {
    const delivery = await import('./idle-delivery');
    const scope = testProjectScope();
    authorizeTarget(scope);
    ptyMocks.state = 'idle';
    delivery.initIdleDelivery();

    delivery.onHandoffSubmitted(
      handoff({
        id: 'handoff-hung',
        fromAgent: 'nexus-delegation-supervisor',
        status: 'stalled',
        summary: '[travado] worker "DeepSeek" (pane-x, deepseek) está há 46 min no meio do turno',
      }),
      scope,
    );
    await advanceUntilSubmitted(delivery);

    expect(ptyMocks.writes).toHaveBeenCalled();
    expect(storeMocks.missionUpdates).toEqual([]);
    expect(
      storeMocks.missions.get(`${scope.projectId}:${scope.checkoutId}:mission-a`)
        ?.status,
    ).toBe('running');
    delivery.shutdownIdleDelivery();
  });

  it('retries Enter once when the CLI swallowed submit and stayed idle', async () => {
    const delivery = await import('./idle-delivery');
    const scope = testProjectScope();
    authorizeTarget(scope);
    ptyMocks.state = 'idle';
    delivery.initIdleDelivery();

    delivery.onHandoffSubmitted(handoff(), scope);
    await advanceUntilSubmitted(delivery);
    await vi.advanceTimersByTimeAsync(delivery.HANDOFF_ENTER_RETRY_MS);

    expect(ptyMocks.writes.mock.calls.filter((call) => call[1] === '\r')).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(ptyMocks.writes.mock.calls.filter((call) => call[1] === '\r')).toHaveLength(2);
    delivery.shutdownIdleDelivery();
  });

  it('does not retry Enter after the first submit made the CLI busy', async () => {
    const delivery = await import('./idle-delivery');
    const scope = testProjectScope();
    authorizeTarget(scope);
    ptyMocks.state = 'idle';
    delivery.initIdleDelivery();

    delivery.onHandoffSubmitted(handoff(), scope);
    await advanceUntilSubmitted(delivery);
    ptyMocks.state = 'busy';
    ptyMocks.stateTaps[0]('orchestrator-session', 'busy');
    await vi.advanceTimersByTimeAsync(delivery.HANDOFF_ENTER_RETRY_MS);

    expect(ptyMocks.writes.mock.calls.filter((call) => call[1] === '\r')).toHaveLength(1);
    delivery.shutdownIdleDelivery();
  });

  it('replays durable pending handoffs after the orchestrator is rebound', async () => {
    const delivery = await import('./idle-delivery');
    const scope = testProjectScope();
    const pending = handoff({ id: 'handoff-persisted' });
    storeMocks.handoffs.set(pending.id, pending);
    authorizeTarget(scope);
    ptyMocks.state = 'idle';
    delivery.initIdleDelivery();

    expect(delivery.redeliverPendingHandoffs(scope, 'mission-a')).toBe(1);
    await advanceUntilSubmitted(delivery);

    expect(ptyMocks.writes).toHaveBeenCalledWith(
      'orchestrator-session',
      expect.stringContaining('completed the requested work'),
      { markInputBusy: false },
    );
    // Submitted só após a prova de aceite (sessão vira busy).
    ptyMocks.state = 'busy';
    ptyMocks.stateTaps[0]('orchestrator-session', 'busy');
    expect(storeMocks.delivered).toEqual([{ scope, id: 'handoff-persisted' }]);
    delivery.shutdownIdleDelivery();
  });

  it('replays durable pending handoffs to the promoted orchestrator session', async () => {
    const delivery = await import('./idle-delivery');
    const scope = testProjectScope();
    const pending = handoff({ id: 'handoff-promoted' });
    storeMocks.handoffs.set(pending.id, pending);
    authorizeTarget(scope);
    storeMocks.missions.set(`${scope.projectId}:${scope.checkoutId}:mission-a`, {
      id: 'mission-a',
      orchestratorSessionId: 'promoted-session',
      status: 'running',
      description: 'Objetivo original',
    });
    paneMocks.authorities.set('promoted-session', {
      owner: { id: 101 },
      paneId: 'promoted-pane',
      sessionId: 'promoted-session',
      kind: 'cli-agent',
      missionId: 'mission-a',
      role: 'orchestrator',
      scope,
    });
    ptyMocks.state = 'idle';
    delivery.initIdleDelivery();

    expect(delivery.redeliverPendingHandoffs(scope, 'mission-a')).toBe(1);
    await vi.advanceTimersByTimeAsync(150);

    expect(ptyMocks.writes).toHaveBeenCalledWith(
      'promoted-session',
      expect.stringContaining('completed the requested work'),
      { markInputBusy: false },
    );
    expect(ptyMocks.writes).not.toHaveBeenCalledWith(
      'orchestrator-session',
      expect.any(String),
      expect.any(Object),
    );
    delivery.shutdownIdleDelivery();
  });

  it('drops queued state when its owning renderer changes workspace', async () => {
    const delivery = await import('./idle-delivery');
    const scopeA = testProjectScope();
    const scopeB = testProjectScope({
      projectId: 'project-b',
      checkoutId: 'checkout-b',
      rootRealPath: '/workspace/b',
    });
    const owner = { id: 202 };
    authorizeTarget(scopeA, owner);
    delivery.initIdleDelivery();

    delivery.onHandoffSubmitted(handoff(), scopeA);
    scopeMocks.listeners[0](owner, scopeA, scopeB);
    ptyMocks.stateTaps[0]('orchestrator-session', 'idle');

    expect(ptyMocks.writes).not.toHaveBeenCalled();
    expect(storeMocks.delivered).toEqual([]);
    delivery.shutdownIdleDelivery();
  });

  it('fails closed on ambiguous, cross-scope, or wrong-mission targets', async () => {
    const delivery = await import('./idle-delivery');
    const scope = testProjectScope();
    const foreignRoot = testProjectScope({ rootRealPath: '/workspace/other' });
    authorizeTarget(scope);
    delivery.initIdleDelivery();
    ptyMocks.state = 'idle';

    paneMocks.authorities.set('orchestrator-session', null);
    delivery.onHandoffSubmitted(handoff({ id: 'ambiguous' }), scope);
    authorizeTarget(scope);
    paneMocks.authorities.set('orchestrator-session', {
      ...(paneMocks.authorities.get('orchestrator-session') as object),
      scope: foreignRoot,
    });
    delivery.onHandoffSubmitted(handoff({ id: 'foreign' }), scope);
    authorizeTarget(scope);
    paneMocks.authorities.set('orchestrator-session', {
      ...(paneMocks.authorities.get('orchestrator-session') as object),
      missionId: 'mission-b',
    });
    delivery.onHandoffSubmitted(handoff({ id: 'wrong-mission' }), scope);

    expect(ptyMocks.writes).not.toHaveBeenCalled();
    expect(storeMocks.delivered).toEqual([]);
    delivery.shutdownIdleDelivery();
  });

  it('entrega no idle um handoff represado que nasceu sem Maestro vinculado', async () => {
    const delivery = await import('./idle-delivery');
    const scope = testProjectScope();
    // Maestro ainda não vinculado: o pane não está no registro, então
    // `targetAuthority` devolve null e NADA é enfileirado em memória.
    storeMocks.missions.set(
      `${scope.projectId}:${scope.checkoutId}:mission-a`,
      {
        id: 'mission-a',
        orchestratorSessionId: 'orchestrator-session',
        status: 'running',
        description: 'Objetivo original',
      },
    );
    const pending = handoff();
    storeMocks.handoffs.set(pending.id, pending);
    delivery.initIdleDelivery();

    expect(delivery.onHandoffSubmitted(pending, scope)).toBeNull();
    await vi.advanceTimersByTimeAsync(2_000);
    // Campo 20/08: era aqui que 4 de 5 handoffs morriam — `queued` para sempre,
    // sem uma única linha em handoff_delivery_attempts.
    expect(ptyMocks.writes).not.toHaveBeenCalled();
    expect(storeMocks.deliveryAttempts.size).toBe(0);

    // O Maestro vincula e fica ocioso: a caixa durável é drenada.
    authorizeTarget(scope);
    ptyMocks.state = 'idle';
    ptyMocks.stateTaps[0]('orchestrator-session', 'idle');
    await advanceUntilPasted(delivery);

    expect(ptyMocks.writes).toHaveBeenCalledWith(
      'orchestrator-session',
      expect.stringContaining('handoff_id=handoff-a'),
      { markInputBusy: false },
    );
    expect(storeMocks.deliveryAttempts.size).toBe(1);
    delivery.shutdownIdleDelivery();
  });

  it('cola um queued que chegou com o Maestro já idle depois do semantic liberar', async () => {
    const delivery = await import('./idle-delivery');
    const scope = testProjectScope();
    authorizeTarget(scope);
    ptyMocks.state = 'idle';
    semanticMocks.injectable = false;
    semanticMocks.status = 'awaiting-input';
    delivery.initIdleDelivery();

    delivery.onHandoffSubmitted(handoff(), scope);
    expect(ptyMocks.writes).not.toHaveBeenCalled();

    semanticMocks.injectable = true;
    semanticMocks.status = 'idle';
    await vi.advanceTimersByTimeAsync(500);
    await advanceUntilPasted(delivery);

    expect(ptyMocks.writes).toHaveBeenCalledWith(
      'orchestrator-session',
      expect.stringContaining('handoff_id=handoff-a'),
      { markInputBusy: false },
    );
    delivery.shutdownIdleDelivery();
  });

  it('missão running: cola queued no PTY idle mesmo com semantic working', async () => {
    // Campo 24/08: 1+1 queued=2 pasted=0 ~34s com Maestro CSS idle e
    // missão ainda running — canPaste só liberava depois do Pronto.
    const delivery = await import('./idle-delivery');
    const scope = testProjectScope();
    authorizeTarget(scope);
    ptyMocks.state = 'idle';
    semanticMocks.injectable = false;
    semanticMocks.status = 'working';
    delivery.initIdleDelivery();

    delivery.onHandoffSubmitted(handoff(), scope);
    await advanceUntilPasted(delivery);

    expect(ptyMocks.writes).toHaveBeenCalledWith(
      'orchestrator-session',
      expect.stringContaining('handoff_id=handoff-a'),
      { markInputBusy: false },
    );
    delivery.shutdownIdleDelivery();
  });

  it('missão já done: cola queued no PTY idle mesmo com semantic working', async () => {
    // Campo 24/08: first-wave 2x2 drenou 3 handoffs no idle do Maestro e
    // zero paste — Pronto já tinha fechado, o hook ficou em working.
    const delivery = await import('./idle-delivery');
    const scope = testProjectScope();
    authorizeTarget(scope);
    storeMocks.missions.set(
      `${scope.projectId}:${scope.checkoutId}:mission-a`,
      {
        id: 'mission-a',
        orchestratorSessionId: 'orchestrator-session',
        status: 'done',
        description: 'How much is 2x2',
      },
    );
    ptyMocks.state = 'idle';
    semanticMocks.injectable = false;
    semanticMocks.status = 'working';
    delivery.initIdleDelivery();

    delivery.onHandoffSubmitted(handoff(), scope);
    await advanceUntilPasted(delivery);

    expect(ptyMocks.writes).toHaveBeenCalledWith(
      'orchestrator-session',
      expect.stringContaining('handoff_id=handoff-a'),
      { markInputBusy: false },
    );
    delivery.shutdownIdleDelivery();
  });

  it('não cola o handoff do próprio Maestro de volta no PTY dele', async () => {
    const delivery = await import('./idle-delivery');
    const scope = testProjectScope();
    authorizeTarget(scope);
    ptyMocks.state = 'idle';
    delivery.initIdleDelivery();

    delivery.onHandoffSubmitted(
      handoff({
        sessionId: 'orchestrator-session',
        fromAgent: 'Coordenar e revisar',
      }),
      scope,
    );
    await advanceUntilPasted(delivery);
    expect(ptyMocks.writes).not.toHaveBeenCalled();
    delivery.shutdownIdleDelivery();
  });

  it('não redigita nem falha quando o Maestro já leu o handoff sem borda busy', async () => {
    const delivery = await import('./idle-delivery');
    const scope = testProjectScope();
    authorizeTarget(scope);
    const pending = handoff();
    storeMocks.handoffs.set(pending.id, pending);
    ptyMocks.state = 'idle';
    delivery.initIdleDelivery();

    delivery.onHandoffSubmitted(pending, scope);
    await advanceUntilSubmitted(delivery);
    expect(ptyMocks.writes).toHaveBeenCalledTimes(2);
    const pastesBefore = ptyMocks.writes.mock.calls.filter((call) =>
      String(call[1]).includes('handoff_id=handoff-a'),
    ).length;

    // list-ack de `nexus_handoff_list`: o Maestro leu, mas o heurístico de
    // busy do TUI nunca pintou. Antes isso virava accept_timeout + reentrega.
    storeMocks.handoffs.set(pending.id, {
      ...pending,
      deliveryState: 'acknowledged',
    });
    await vi.advanceTimersByTimeAsync(
      delivery.SUBMIT_ACCEPTANCE_WINDOW_MS + 1_000,
    );

    const attempts = [...storeMocks.deliveryAttempts.values()];
    expect(attempts).toHaveLength(1);
    expect(attempts[0].state).toBe('accepted');
    const pastesAfter = ptyMocks.writes.mock.calls.filter((call) =>
      String(call[1]).includes('handoff_id=handoff-a'),
    ).length;
    expect(pastesAfter).toBe(pastesBefore);
    delivery.shutdownIdleDelivery();
  });

  it('prova de aceite via turn-start tap sem borda busy do TUI (F-113)', async () => {
    const delivery = await import('./idle-delivery');
    const scope = testProjectScope();
    authorizeTarget(scope);
    const pending = handoff();
    storeMocks.handoffs.set(pending.id, pending);
    ptyMocks.state = 'idle';
    delivery.initIdleDelivery();

    delivery.onHandoffSubmitted(pending, scope);
    await advanceUntilSubmitted(delivery);

    // PTY continua 'idle' (TUI não pintou borda busy), mas o hook nativo emitiu turn-start
    for (const tap of semanticMocks.turnStartTaps) {
      tap({
        sessionId: 'orchestrator-session',
        paneId: 'orchestrator-pane',
        sequence: 1,
        observedAt: Date.now(),
      });
    }

    const attempts = [...storeMocks.deliveryAttempts.values()];
    expect(attempts).toHaveLength(1);
    expect(attempts[0].state).toBe('accepted');
    delivery.shutdownIdleDelivery();
  });

  it('prova de aceite via semantic status working sem borda busy do TUI (F-113)', async () => {
    const delivery = await import('./idle-delivery');
    const scope = testProjectScope();
    authorizeTarget(scope);
    const pending = handoff();
    storeMocks.handoffs.set(pending.id, pending);
    ptyMocks.state = 'idle';
    delivery.initIdleDelivery();

    delivery.onHandoffSubmitted(pending, scope);
    await advanceUntilSubmitted(delivery);

    // Semantic status mudou para working sem borda busy no PTY
    for (const tap of semanticMocks.taps) {
      tap({
        sessionId: 'orchestrator-session',
        status: 'working',
        updatedAt: Date.now(),
      });
    }

    const attempts = [...storeMocks.deliveryAttempts.values()];
    expect(attempts).toHaveLength(1);
    expect(attempts[0].state).toBe('accepted');
    delivery.shutdownIdleDelivery();
  });

  it('prova de aceite via turn sequence progress na expiração do timeout (F-113)', async () => {
    const delivery = await import('./idle-delivery');
    const scope = testProjectScope();
    authorizeTarget(scope);
    const pending = handoff();
    storeMocks.handoffs.set(pending.id, pending);
    ptyMocks.state = 'idle';
    delivery.initIdleDelivery();

    delivery.onHandoffSubmitted(pending, scope);
    await advanceUntilSubmitted(delivery);

    // Turn sequence avançou enquanto aguardava
    semanticMocks.turnSequence = 2;

    await vi.advanceTimersByTimeAsync(
      delivery.SUBMIT_ACCEPTANCE_WINDOW_MS + 1_000,
    );

    const attempts = [...storeMocks.deliveryAttempts.values()];
    expect(attempts).toHaveLength(1);
    expect(attempts[0].state).toBe('accepted');
    delivery.shutdownIdleDelivery();
  });

  it('formata metadados de Context DAG estruturado em formatDelivery', async () => {
    const delivery = await import('./idle-delivery');
    const h = handoff({
      artifacts: [
        { kind: 'context.accomplished', payload: ['auth refactor', 'unit tests'] },
        { kind: 'context.blockers', payload: 'backend redis timeout' },
        { kind: 'context.nextSteps', payload: ['deploy migration', 'run smoke test'] },
      ],
    });

    const formatted = delivery.formatDelivery(h);
    expect(formatted).toContain('context_dag=[');
    expect(formatted).toContain('accomplished="auth refactor; unit tests"');
    expect(formatted).toContain('blockers="backend redis timeout"');
    expect(formatted).toContain('next_steps="deploy migration; run smoke test"');
  });
});
