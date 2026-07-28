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
  taps: [] as Array<(entry: {
    sessionId: string;
    status: 'idle' | 'completed' | 'awaiting-input' | 'working';
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
    { orchestratorSessionId?: string; status?: string; description?: string }
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
    state: string;
  }>,
  delivered: [] as Array<{ scope: ProjectExecutionScope; id: string }>,
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
  isSessionInjectableIdle: vi.fn(
    () => ptyMocks.state === 'idle' && semanticMocks.injectable,
  ),
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
        const attemptNo = [...storeMocks.deliveryAttempts.values()]
          .filter((attempt) => attempt.handoffId === handoffId).length + 1;
        if (attemptNo > maxAttempts) {
          throw new Error('handoff delivery attempt budget exhausted');
        }
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

function authorizeTarget(
  scope: ProjectExecutionScope,
  owner: { id: number } = { id: 101 },
): void {
  storeMocks.missions.set(
    `${scope.projectId}:${scope.checkoutId}:mission-a`,
    {
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
  semanticMocks.taps.length = 0;
  scopeMocks.scopesByOwner.clear();
  scopeMocks.listeners.length = 0;
  storeMocks.missions.clear();
  storeMocks.missionUpdates.length = 0;
  storeMocks.handoffs.clear();
  storeMocks.taskDispatches.length = 0;
  storeMocks.delivered.length = 0;
  storeMocks.deliveryAttempts.clear();
  storeMocks.nextAttemptId = 1;
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe('idle delivery authority and lifecycle', () => {
  it('does not paste or submit while an idle-looking permission prompt is active', async () => {
    const delivery = await import('./idle-delivery');
    const scope = testProjectScope();
    authorizeTarget(scope);
    ptyMocks.state = 'idle';
    semanticMocks.injectable = false;
    delivery.initIdleDelivery();

    delivery.onHandoffSubmitted(handoff(), scope);
    ptyMocks.stateTaps[0]('orchestrator-session', 'idle');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(ptyMocks.writes).not.toHaveBeenCalled();

    semanticMocks.injectable = true;
    semanticMocks.taps[0]({
      sessionId: 'orchestrator-session',
      status: 'completed',
    });
    expect(ptyMocks.writes).toHaveBeenCalledTimes(1);
    expect(ptyMocks.writes).not.toHaveBeenCalledWith(
      'orchestrator-session',
      '\r',
      { markInputBusy: false },
    );
    await vi.advanceTimersByTimeAsync(150);
    expect(ptyMocks.writes).toHaveBeenLastCalledWith(
      'orchestrator-session',
      '\r',
      { markInputBusy: false },
    );
    delivery.shutdownIdleDelivery();
  });

  it('delivers to a main-owned orchestrator while no renderer is alive', async () => {
    const delivery = await import('./idle-delivery');
    const scope = testProjectScope();
    authorizeMainOwnedTarget(scope);
    ptyMocks.state = 'idle';
    delivery.initIdleDelivery();

    delivery.onHandoffSubmitted(handoff(), scope);

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

    expect(ptyMocks.writes).toHaveBeenCalledWith(
      'orchestrator-session',
      expect.stringMatching(/evidence=stale.*does_not_complete_mission/i),
      { markInputBusy: false },
    );
    delivery.shutdownIdleDelivery();
  });

  it('cancels the delayed submit Enter when the exact session exits', async () => {
    const delivery = await import('./idle-delivery');
    const scope = testProjectScope();
    authorizeTarget(scope);
    ptyMocks.state = 'idle';
    delivery.initIdleDelivery();

    delivery.onHandoffSubmitted(handoff(), scope);
    ptyMocks.exitTaps[0]('orchestrator-session');
    await vi.advanceTimersByTimeAsync(200);

    expect(ptyMocks.writes).toHaveBeenCalledTimes(1);
    expect(ptyMocks.writes).not.toHaveBeenCalledWith(
      'orchestrator-session',
      '\r',
    );
    expect(storeMocks.delivered).toEqual([]);
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
    await vi.advanceTimersByTimeAsync(150);

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
    await vi.advanceTimersByTimeAsync(150);
    expect(ptyMocks.writes).toHaveBeenLastCalledWith(
      'orchestrator-session',
      '\r',
      { markInputBusy: false },
    );
    expect(storeMocks.delivered).toEqual([]);
    delivery.shutdownIdleDelivery();
  });

  it('captures a fast busy→idle turn during the Enter retry window without duplicating', async () => {
    const delivery = await import('./idle-delivery');
    const scope = testProjectScope();
    authorizeTarget(scope);
    ptyMocks.state = 'idle';
    delivery.initIdleDelivery();

    delivery.onHandoffSubmitted(handoff(), scope);
    await vi.advanceTimersByTimeAsync(150);
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

    expect(ptyMocks.writes.mock.calls.filter((call) =>
      String(call[1]).includes('handoff_id=handoff-'),
    )).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(150);
    ptyMocks.state = 'busy';
    ptyMocks.stateTaps[0]('orchestrator-session', 'busy');
    expect(storeMocks.delivered).toEqual([{ scope, id: 'handoff-first' }]);

    ptyMocks.state = 'idle';
    ptyMocks.stateTaps[0]('orchestrator-session', 'idle');
    expect(ptyMocks.writes.mock.calls.filter((call) =>
      String(call[1]).includes('handoff_id=handoff-'),
    )).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(150);
    ptyMocks.state = 'busy';
    ptyMocks.stateTaps[0]('orchestrator-session', 'busy');
    expect(storeMocks.delivered).toEqual([
      { scope, id: 'handoff-first' },
      { scope, id: 'handoff-second' },
    ]);
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

    // Janela de aceite estoura sem busy: não marca submitted e re-entrega 1×.
    await vi.advanceTimersByTimeAsync(13_000);
    expect(storeMocks.delivered).toEqual([]);
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

    const attempts = [...storeMocks.deliveryAttempts.values()];
    expect(attempts).toHaveLength(2);
    expect(attempts[0]).toMatchObject({ attemptNo: 1, state: 'failed' });
    expect(attempts[1]).toMatchObject({ attemptNo: 2, state: 'reserved' });
    expect(ptyMocks.writes.mock.calls.filter((call) =>
      String(call[1]).includes('handoff_id=handoff-a'),
    )).toHaveLength(2);

    await vi.advanceTimersByTimeAsync(150);
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
    await vi.advanceTimersByTimeAsync(300);

    const attempts = [...storeMocks.deliveryAttempts.values()];
    expect(attempts).toHaveLength(2);
    expect(attempts[0]).toMatchObject({ attemptNo: 1, state: 'failed' });
    expect(attempts[1]).toMatchObject({ attemptNo: 2, state: 'pasted' });
    ptyMocks.state = 'busy';
    ptyMocks.stateTaps[0]('orchestrator-session', 'busy');
    expect(storeMocks.delivered).toEqual([{ scope, id: 'handoff-a' }]);
    delivery.shutdownIdleDelivery();
  });

  it('bloqueia com sinal durável após a reentrega limitada também não ser aceita', async () => {
    const delivery = await import('./idle-delivery');
    const scope = testProjectScope();
    authorizeTarget(scope);
    ptyMocks.state = 'idle';
    delivery.initIdleDelivery();

    delivery.onHandoffSubmitted(handoff(), scope);
    await vi.advanceTimersByTimeAsync(25_000);

    const deliveries = ptyMocks.writes.mock.calls.filter((call) =>
      String(call[1]).includes('completed the requested work'),
    );
    expect(deliveries).toHaveLength(2);
    expect(storeMocks.delivered).toEqual([]);
    expect(storeMocks.missionUpdates).toEqual([
      {
        scope,
        id: 'mission-a',
        patch: expect.objectContaining({
          status: 'blocked',
          description: expect.stringMatching(/Handoff não entregue.*Reabrir/s),
        }),
      },
    ]);
    delivery.shutdownIdleDelivery();
  });

  it('não bloqueia a missão quando o dispatcher durável já possui o handoff', async () => {
    const delivery = await import('./idle-delivery');
    const scope = testProjectScope();
    authorizeTarget(scope);
    storeMocks.taskDispatches.push({
      handoffId: 'handoff-a',
      missionId: 'mission-a',
      state: 'merging',
    });
    ptyMocks.state = 'idle';
    delivery.initIdleDelivery();

    delivery.onHandoffSubmitted(handoff(), scope);
    await vi.advanceTimersByTimeAsync(25_000);

    expect(storeMocks.delivered).toEqual([]);
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
    await vi.advanceTimersByTimeAsync(550);

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
    await vi.advanceTimersByTimeAsync(150);
    ptyMocks.state = 'busy';
    ptyMocks.stateTaps[0]('orchestrator-session', 'busy');
    await vi.advanceTimersByTimeAsync(400);

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
    await vi.advanceTimersByTimeAsync(150);

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
});
