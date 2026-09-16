import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Handoff } from '../../shared/orch-types';
import type { ProjectExecutionScope } from '../../shared/types';
import { testProjectScope } from './__tests__/scope-fixture';

const ptyMocks = vi.hoisted(() => ({
  state: 'busy' as string | null,
  writes: vi.fn((_sessionId: string, _data: string) => true),
  stateTaps: [] as Array<(sessionId: string, state: string) => void>,
  exitTaps: [] as Array<(sessionId: string) => void>,
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
  }>(),
  nextAttemptId: 1,
}));

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
}));

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
            attempt.orchestratorSessionId === orchestratorSessionId,
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
      acceptDeliveryAttempt: ({
        attemptId,
        handoffId,
      }: { attemptId: string; handoffId: string }) => {
        const attempt = storeMocks.deliveryAttempts.get(attemptId);
        if (!attempt || attempt.state !== 'pasted') return false;
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

  it('serializa dois handoffs no mesmo idle e exige uma borda busy para cada um', async () => {
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

    expect(ptyMocks.writes.mock.calls.filter((call) =>
      String(call[1]).includes('handoff_id=handoff-'),
    )).toHaveLength(1);
    ptyMocks.state = 'busy';
    ptyMocks.stateTaps[0]('orchestrator-session', 'busy');
    expect(storeMocks.delivered).toEqual([{ scope, id: 'handoff-first' }]);

    ptyMocks.state = 'idle';
    ptyMocks.stateTaps[0]('orchestrator-session', 'idle');
    await advanceUntilSubmitted(delivery);
    expect(ptyMocks.writes.mock.calls.filter((call) =>
      String(call[1]).includes('handoff_id=handoff-'),
    )).toHaveLength(2);
    ptyMocks.state = 'busy';
    ptyMocks.stateTaps[0]('orchestrator-session', 'busy');
    expect(storeMocks.delivered).toEqual([
      { scope, id: 'handoff-first' },
      { scope, id: 'handoff-second' },
    ]);
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
