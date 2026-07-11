import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const publishSessionActivityState = vi.fn((_sessionId: string, _state: string) => true);
const recordCrashBreadcrumb = vi.fn();
const getCrashBreadcrumbSnapshot = vi.fn(() => []);
const registerRecoveryAttempt = vi.fn(() => ({ allowed: true }));

vi.mock('../pty/pty-manager', () => ({
  publishSessionActivityState: (sessionId: string, state: string) =>
    publishSessionActivityState(sessionId, state),
}));

vi.mock('../crash-reporting/crash-breadcrumb-store', () => ({
  recordCrashBreadcrumb: (name: string, data?: unknown) =>
    recordCrashBreadcrumb(name, data),
  getCrashBreadcrumbSnapshot: () => getCrashBreadcrumbSnapshot(),
  clearCrashBreadcrumbsForTest: () => undefined,
}));

vi.mock('../crash-reporting/crash-report-store', () => {
  class FakeStore {
    static fromUserData() {
      return new FakeStore();
    }
    async record() {
      return { id: 'r1' };
    }
  }
  return { CrashReportStore: FakeStore };
});

vi.mock('electron', () => ({
  app: {
    getPath: () => '/tmp',
    getVersion: () => '0.13.0-test',
    getAppMetrics: () => [],
  },
  powerMonitor: { on: vi.fn(), off: vi.fn() },
  powerSaveBlocker: {
    start: vi.fn(() => 1),
    stop: vi.fn(),
    isStarted: vi.fn(() => true),
  },
}));

import {
  __resetAgentRuntimeBridgeForTests,
  disposeAgentAwakeService,
  getAgentAwakeService,
  handleRenderProcessGone,
  publishAgentHookActivity,
} from './agent-runtime-bridge';
import { ingestAgentHookStatus } from '../agent-hooks/hook-ingest';
import { __resetHookIngestForTests } from '../agent-hooks/hook-ingest';

beforeEach(() => {
  publishSessionActivityState.mockClear();
  recordCrashBreadcrumb.mockClear();
  registerRecoveryAttempt.mockClear().mockReturnValue({ allowed: true });
  __resetAgentRuntimeBridgeForTests();
  __resetHookIngestForTests();
});

afterEach(() => {
  disposeAgentAwakeService();
});

describe('agent-runtime-bridge production seam', () => {
  it('maps hook status to pane state and publishes via pty-manager', () => {
    const result = publishAgentHookActivity('working', {
      sessionId: 'pty-abc',
      agentType: 'claude',
    });
    expect(result.authorizesEvidence).toBe(false);
    expect(result.paneSessionState).toBe('busy');
    expect(publishSessionActivityState).toHaveBeenCalledWith('pty-abc', 'busy');
    expect(recordCrashBreadcrumb).toHaveBeenCalled();
  });

  it('ingestAgentHookStatus routes through listener module to pane state', () => {
    const result = ingestAgentHookStatus('pty-1', {
      state: 'done',
      prompt: 'ship it',
      agentType: 'codex',
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.paneSessionState).toBe('idle');
      expect(result.authorizesEvidence).toBe(false);
    }
    expect(publishSessionActivityState).toHaveBeenCalledWith('pty-1', 'idle');
  });

  it('handleRenderProcessGone records breadcrumb and uses circuit breaker', () => {
    const circuitBreaker = {
      registerRecoveryAttempt,
      reset: vi.fn(),
    };
    const decision = handleRenderProcessGone({
      details: { reason: 'crashed', exitCode: 1 },
      circuitBreaker: circuitBreaker as never,
      windowDestroyed: false,
    });
    expect(decision.reload).toBe(true);
    expect(decision.recoveryAllowed).toBe(true);
    expect(registerRecoveryAttempt).toHaveBeenCalled();
    expect(recordCrashBreadcrumb).toHaveBeenCalledWith(
      'render-process-gone',
      expect.objectContaining({ reason: 'crashed' }),
    );
  });

  it('resets the process-gone dedupe between test runs (no cross-test leak)', () => {
    const circuitBreaker = { registerRecoveryAttempt, reset: vi.fn() };
    const crash = () =>
      handleRenderProcessGone({
        details: { reason: 'crashed', exitCode: 1 },
        circuitBreaker: circuitBreaker as never,
        now: 1_000,
        windowDestroyed: false,
      });
    // First occurrence records; an identical one in the same window is deduped.
    expect(crash().recorded).toBe(true);
    expect(crash().recorded).toBe(false);
    // Reset must clear the module-global dedupe so a fresh run records again.
    __resetAgentRuntimeBridgeForTests();
    expect(crash().recorded).toBe(true);
  });

  it('getAgentAwakeService returns a live singleton', () => {
    const a = getAgentAwakeService();
    const b = getAgentAwakeService();
    expect(a).toBe(b);
    a.setStatuses([
      {
        state: 'working',
        receivedAt: Date.now(),
        observedInCurrentRuntime: true,
      },
    ]);
  });
});
