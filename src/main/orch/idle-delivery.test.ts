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
  missions: new Map<string, { orchestratorSessionId?: string }>(),
  handoffs: new Map<string, Handoff>(),
  delivered: [] as Array<{ scope: ProjectExecutionScope; id: string }>,
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
    },
    handoffs: {
      get: (id: string) =>
        storeMocks.handoffs.get(id) ?? handoff({ id }),
      markSubmitted: (id: string) => storeMocks.delivered.push({ scope, id }),
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
    { orchestratorSessionId: 'orchestrator-session' },
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

beforeEach(() => {
  vi.useFakeTimers();
  vi.resetModules();
  ptyMocks.state = 'busy';
  ptyMocks.writes.mockClear();
  ptyMocks.stateTaps.length = 0;
  ptyMocks.exitTaps.length = 0;
  paneMocks.authorities.clear();
  scopeMocks.scopesByOwner.clear();
  scopeMocks.listeners.length = 0;
  storeMocks.missions.clear();
  storeMocks.handoffs.clear();
  storeMocks.delivered.length = 0;
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe('idle delivery authority and lifecycle', () => {
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
    ptyMocks.stateTaps[0]('orchestrator-session', 'idle');

    expect(ptyMocks.writes).toHaveBeenCalledWith(
      'orchestrator-session',
      expect.stringMatching(/evidence=stale.*does_not_complete_mission/i),
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

    expect(ptyMocks.writes).toHaveBeenLastCalledWith('orchestrator-session', '\r');
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
    expect(ptyMocks.writes).toHaveBeenLastCalledWith('orchestrator-session', '\r');
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
