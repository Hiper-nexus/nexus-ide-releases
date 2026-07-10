import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProjectExecutionScope } from '../../shared/types';
import type { PaneAuthzInfo } from './pane-authz';

const ptyMocks = vi.hoisted(() => ({
  dataTaps: [] as Array<(sessionId: string, data: string) => void>,
  exitTaps: [] as Array<(sessionId: string) => void>,
  tapSessionData: vi.fn((tap: (sessionId: string, data: string) => void) => {
    ptyMocks.dataTaps.push(tap);
  }),
  tapSessionExit: vi.fn((tap: (sessionId: string) => void) => {
    ptyMocks.exitTaps.push(tap);
  }),
}));

const paneMocks = vi.hoisted(() => ({
  byRef: new Map<string, PaneAuthzInfo | null>(),
  getPaneAuthzInfo: vi.fn((ref: string) => paneMocks.byRef.get(ref) ?? null),
  findPane: vi.fn(() => null),
}));

vi.mock('../pty/pty-manager', () => ({
  tapSessionData: ptyMocks.tapSessionData,
  tapSessionExit: ptyMocks.tapSessionExit,
}));

vi.mock('./pane-registry', () => ({
  getPaneAuthzInfo: paneMocks.getPaneAuthzInfo,
  findPane: paneMocks.findPane,
}));

vi.mock('./pricing', () => ({
  estimateTokens: (data: string) => data.length,
  estimateCost: (_model: string | undefined, _input: number, output: number) =>
    output / 100,
}));

function scope(overrides: Partial<ProjectExecutionScope>): ProjectExecutionScope {
  return Object.freeze({
    version: 1,
    installationId: 'installation-a',
    projectId: 'project-shared',
    checkoutId: 'checkout-shared',
    rootRealPath: '/workspace/a',
    identitySource: 'manifest',
    ...overrides,
  });
}

function pane(
  executionScope: ProjectExecutionScope | undefined,
  sessionId: string,
): PaneAuthzInfo {
  return {
    paneId: 'shared-pane',
    sessionId,
    kind: 'cli-agent',
    scope: executionScope,
  };
}

describe('project-scoped heuristic cost tracker', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.resetModules();
    ptyMocks.dataTaps.length = 0;
    ptyMocks.exitTaps.length = 0;
    ptyMocks.tapSessionData.mockClear();
    ptyMocks.tapSessionExit.mockClear();
    paneMocks.byRef.clear();
    paneMocks.getPaneAuthzInfo.mockClear();
    paneMocks.findPane.mockClear();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('includes every authority coordinate in the telemetry partition', async () => {
    const tracker = await import('./cost-tracker');
    const scopes = [
      scope({}),
      scope({ installationId: 'installation-b' }),
      scope({ projectId: 'project-b' }),
      scope({ checkoutId: 'checkout-b' }),
      scope({ rootRealPath: '/workspace/root-b' }),
    ];
    scopes.forEach((executionScope, index) => {
      const sessionId = `coordinate-session-${index}`;
      paneMocks.byRef.set(sessionId, pane(executionScope, sessionId));
    });
    tracker.initCostTracker();

    scopes.forEach((_executionScope, index) => {
      ptyMocks.dataTaps[0](
        `coordinate-session-${index}`,
        'x'.repeat(index + 1),
      );
    });

    expect(
      scopes.map((executionScope) =>
        tracker.getCostSnapshot(executionScope).totalUsd,
      ),
    ).toEqual([0.01, 0.02, 0.03, 0.04, 0.05]);
  });

  it('isolates panes, rolling rates, caps and events by exact execution scope', async () => {
    const tracker = await import('./cost-tracker');
    const scopeA = scope({});
    const scopeB = scope({
      installationId: 'installation-b',
      rootRealPath: '/workspace/b',
    });
    const unknownScope = scope({
      installationId: 'installation-c',
      rootRealPath: '/workspace/c',
    });
    const paneA = pane(scopeA, 'session-a');
    const paneB = pane(scopeB, 'session-b');
    paneMocks.byRef.set('session-a', paneA);
    paneMocks.byRef.set('session-b', paneB);
    paneMocks.byRef.set('unbound-session', pane(undefined, 'unbound-session'));
    // paneId alone is ambiguous globally; scoped lookup must still distinguish it.
    paneMocks.byRef.set('shared-pane', null);
    const changes: Array<{
      scope: ProjectExecutionScope;
      totalUsd: number;
    }> = [];
    tracker.onCostChange((changedScope, snapshot) => {
      changes.push({ scope: changedScope, totalUsd: snapshot.totalUsd });
    });

    tracker.initCostTracker();
    tracker.initCostTracker();

    expect(ptyMocks.tapSessionData).toHaveBeenCalledOnce();
    expect(ptyMocks.tapSessionExit).toHaveBeenCalledOnce();
    ptyMocks.dataTaps[0]('session-a', 'aaaa');
    ptyMocks.dataTaps[0]('session-b', 'bbbbbbbb');
    ptyMocks.dataTaps[0]('unbound-session', 'must-be-ignored');

    expect(tracker.getCostSnapshot(scopeA)).toMatchObject({
      totalUsd: 0.04,
      perMinuteUsd: 0.04,
      tokPerSec: 4 / 60,
      panes: [{ paneId: 'shared-pane', sessionId: 'session-a', paused: false }],
    });
    expect(tracker.getCostSnapshot(scopeB)).toMatchObject({
      totalUsd: 0.08,
      perMinuteUsd: 0.08,
      tokPerSec: 8 / 60,
      panes: [{ paneId: 'shared-pane', sessionId: 'session-b', paused: false }],
    });
    expect(tracker.getCostSnapshot(unknownScope)).toEqual({
      totalUsd: 0,
      perMinuteUsd: 0,
      tokPerSec: 0,
      panes: [],
    });

    expect(tracker.setPaneCap(scopeA, 'shared-pane', 0.03)).toBe(true);
    expect(tracker.setPaneCap(unknownScope, 'shared-pane', 0.01)).toBe(false);
    expect(tracker.getCostSnapshot(scopeA).panes[0]).toMatchObject({
      capUsd: 0.03,
      paused: true,
    });
    expect(tracker.getCostSnapshot(scopeB).panes[0]).toMatchObject({
      capUsd: undefined,
      paused: false,
    });

    await vi.advanceTimersByTimeAsync(1_000);
    expect(changes).toEqual(
      expect.arrayContaining([
        { scope: scopeA, totalUsd: 0.04 },
        { scope: scopeB, totalUsd: 0.08 },
      ]),
    );
    expect(changes.every((event) => event.totalUsd !== 0.12)).toBe(true);
  });
});
