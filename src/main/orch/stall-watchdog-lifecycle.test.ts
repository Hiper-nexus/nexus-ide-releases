import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProjectExecutionScope } from '../../shared/types';
import { testProjectScope } from './__tests__/scope-fixture';

const ptyMocks = vi.hoisted(() => ({
  dataTaps: [] as Array<(sessionId: string, data: string) => void>,
  stateTaps: [] as Array<(sessionId: string, state: string) => void>,
  exitTaps: [] as Array<(sessionId: string) => void>,
}));

const paneMocks = vi.hoisted(() => ({
  panes: [] as Array<Record<string, unknown>>,
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

const handoffMocks = vi.hoisted(() => ({
  submitted: [] as Array<{ scope: ProjectExecutionScope; input: unknown }>,
  delivered: vi.fn(),
}));
vi.mock('../pty/pty-manager', () => ({
  tapSessionData: vi.fn((tap: (sessionId: string, data: string) => void) => {
    ptyMocks.dataTaps.push(tap);
    return () => {
      const index = ptyMocks.dataTaps.indexOf(tap);
      if (index >= 0) ptyMocks.dataTaps.splice(index, 1);
    };
  }),
  tapSessionState: vi.fn((tap: (sessionId: string, state: string) => void) => {
    ptyMocks.stateTaps.push(tap);
    return () => {
      const index = ptyMocks.stateTaps.indexOf(tap);
      if (index >= 0) ptyMocks.stateTaps.splice(index, 1);
    };
  }),
  tapSessionExit: vi.fn((tap: (sessionId: string) => void) => {
    ptyMocks.exitTaps.push(tap);
    return () => {
      const index = ptyMocks.exitTaps.indexOf(tap);
      if (index >= 0) ptyMocks.exitTaps.splice(index, 1);
    };
  }),
}));

vi.mock('./pane-registry', () => ({
  listPaneSnapshots: vi.fn(() => paneMocks.panes),
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
    handoffs: {
      submit: (input: unknown) => {
        handoffMocks.submitted.push({ scope, input });
        return {
          id: `handoff-${handoffMocks.submitted.length}`,
          ...(input as object),
          artifacts: [],
          delivered: false,
          createdAt: Date.now(),
        };
      },
    },
  })),
}));

vi.mock('./idle-delivery', () => ({
  onHandoffSubmitted: handoffMocks.delivered,
}));

function addWorker(options: {
  ownerId: number;
  paneId: string;
  sessionId: string;
  missionId: string;
  scope: ProjectExecutionScope;
}): void {
  const owner = { id: options.ownerId };
  paneMocks.panes.push({
    paneId: options.paneId,
    sessionId: options.sessionId,
    title: options.paneId,
    kind: 'cli-agent',
    state: 'busy',
  });
  paneMocks.authorities.set(options.sessionId, {
    owner,
    paneId: options.paneId,
    sessionId: options.sessionId,
    kind: 'cli-agent',
    role: 'worker',
    missionId: options.missionId,
    scope: options.scope,
  });
  scopeMocks.scopesByOwner.set(owner.id, options.scope);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  vi.resetModules();
  ptyMocks.dataTaps.length = 0;
  ptyMocks.stateTaps.length = 0;
  ptyMocks.exitTaps.length = 0;
  paneMocks.panes.length = 0;
  paneMocks.authorities.clear();
  scopeMocks.scopesByOwner.clear();
  scopeMocks.listeners.length = 0;
  handoffMocks.submitted.length = 0;
  handoffMocks.delivered.mockClear();
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe('stall watchdog scoped lifecycle', () => {
  it('never restarts or resends work after prolonged silence', async () => {
    const watchdog = await import('./stall-watchdog');
    const scope = testProjectScope();
    addWorker({ ownerId: 99, paneId: 'recover-pane', sessionId: 'recover-session', missionId: 'mission-r', scope });
    watchdog.initStallWatchdog();

    await vi.advanceTimersByTimeAsync(
      watchdog.STALL_SCAN_MS + watchdog.STALL_MS * 3,
    );

    expect(handoffMocks.submitted).toHaveLength(1);
    expect(handoffMocks.submitted[0]?.input).toEqual(
      expect.objectContaining({ status: 'stalled' }),
    );
    watchdog.shutdownStallWatchdog();
  });

  it('treats provider hook state as activity even without PTY bytes', async () => {
    const watchdog = await import('./stall-watchdog');
    const scope = testProjectScope();
    addWorker({ ownerId: 98, paneId: 'active-pane', sessionId: 'active-session', missionId: 'mission-a', scope });
    watchdog.initStallWatchdog();

    await vi.advanceTimersByTimeAsync(watchdog.STALL_SCAN_MS);
    await vi.advanceTimersByTimeAsync(watchdog.STALL_MS - watchdog.STALL_SCAN_MS);
    ptyMocks.stateTaps[0]?.('active-session', 'busy');
    await vi.advanceTimersByTimeAsync(watchdog.STALL_MS - watchdog.STALL_SCAN_MS);

    expect(handoffMocks.submitted).toEqual([]);
    watchdog.shutdownStallWatchdog();
  });
  it('isolates identical pane ids by owner, exact scope, mission and session', async () => {
    const watchdog = await import('./stall-watchdog');
    const scopeA = testProjectScope();
    const scopeB = testProjectScope({
      installationId: 'installation-b',
      projectId: 'project-b',
      checkoutId: 'checkout-b',
      rootRealPath: '/workspace/b',
    });
    addWorker({
      ownerId: 101,
      paneId: 'shared-pane',
      sessionId: 'session-a',
      missionId: 'mission-a',
      scope: scopeA,
    });
    addWorker({
      ownerId: 202,
      paneId: 'shared-pane',
      sessionId: 'session-b',
      missionId: 'mission-b',
      scope: scopeB,
    });
    watchdog.initStallWatchdog();

    await vi.advanceTimersByTimeAsync(
      watchdog.STALL_SCAN_MS + watchdog.STALL_MS,
    );

    expect(handoffMocks.submitted).toEqual([
      expect.objectContaining({
        scope: scopeA,
        input: expect.objectContaining({
          missionId: 'mission-a',
          sessionId: 'session-a',
        }),
      }),
      expect.objectContaining({
        scope: scopeB,
        input: expect.objectContaining({
          missionId: 'mission-b',
          sessionId: 'session-b',
        }),
      }),
    ]);
    expect(handoffMocks.delivered).toHaveBeenCalledTimes(2);
    watchdog.shutdownStallWatchdog();
  });

  it('fails closed for ambiguous or unscoped session authority', async () => {
    const watchdog = await import('./stall-watchdog');
    const scope = testProjectScope();
    addWorker({
      ownerId: 303,
      paneId: 'ambiguous-pane',
      sessionId: 'ambiguous-session',
      missionId: 'mission-a',
      scope,
    });
    paneMocks.authorities.set('ambiguous-session', null);
    addWorker({
      ownerId: 404,
      paneId: 'unscoped-pane',
      sessionId: 'unscoped-session',
      missionId: 'mission-b',
      scope,
    });
    paneMocks.authorities.set('unscoped-session', {
      ...(paneMocks.authorities.get('unscoped-session') as object),
      scope: undefined,
    });
    watchdog.initStallWatchdog();

    await vi.advanceTimersByTimeAsync(
      watchdog.STALL_SCAN_MS + watchdog.STALL_MS,
    );

    expect(handoffMocks.submitted).toEqual([]);
    expect(handoffMocks.delivered).not.toHaveBeenCalled();
    watchdog.shutdownStallWatchdog();
  });

  it('drops watch state on workspace switch and session exit', async () => {
    const watchdog = await import('./stall-watchdog');
    const scopeA = testProjectScope();
    const scopeB = testProjectScope({
      projectId: 'project-b',
      checkoutId: 'checkout-b',
      rootRealPath: '/workspace/b',
    });
    addWorker({
      ownerId: 505,
      paneId: 'pane-a',
      sessionId: 'session-a',
      missionId: 'mission-a',
      scope: scopeA,
    });
    watchdog.initStallWatchdog();
    await vi.advanceTimersByTimeAsync(watchdog.STALL_SCAN_MS);

    scopeMocks.scopesByOwner.set(505, scopeB);
    scopeMocks.listeners[0]({ id: 505 }, scopeA, scopeB);
    ptyMocks.exitTaps[0]('session-a');
    await vi.advanceTimersByTimeAsync(watchdog.STALL_MS);

    expect(handoffMocks.submitted).toEqual([]);
    watchdog.shutdownStallWatchdog();
  });
});
