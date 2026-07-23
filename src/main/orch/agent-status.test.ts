import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CanonicalHookEvent } from '../../vendor/emdash/hooks/hooks-types';

const harness = vi.hoisted(() => ({
  publish: vi.fn((_sessionId: string, _state: string) => true),
  state: 'idle' as string | null,
  agentInfo: vi.fn(
    (_sessionId: string): { paneId?: string } | null => null,
  ),
}));

vi.mock('../pty/pty-manager', () => ({
  publishSessionActivityState: (sessionId: string, state: string) =>
    harness.publish(sessionId, state),
  getAgentSessionInfo: (sessionId: string) => harness.agentInfo(sessionId),
  getSessionState: () => harness.state,
}));

import {
  __resetAgentStatusForTests,
  applyCanonicalHookEvent,
  getAgentSemanticStatus,
  isSessionInjectableIdle,
  paneStateForStatus,
  resetAgentStatusOnExit,
  semanticStatusForEvent,
  tapAgentSemanticStatus,
} from './agent-status';

const start: CanonicalHookEvent = { kind: 'status', type: 'start' };
const userSubmit: CanonicalHookEvent = {
  kind: 'status',
  type: 'start',
  clearsAwaitingInput: true,
};
const stop: CanonicalHookEvent = { kind: 'status', type: 'stop' };
const failure: CanonicalHookEvent = { kind: 'status', type: 'error' };
const permission: CanonicalHookEvent = {
  kind: 'status',
  type: 'notification',
  notificationType: 'permission_prompt',
  message: 'Claude needs your permission to run Bash',
};
const elicitation: CanonicalHookEvent = {
  kind: 'status',
  type: 'notification',
  notificationType: 'elicitation_dialog',
};
const idlePrompt: CanonicalHookEvent = {
  kind: 'status',
  type: 'notification',
  notificationType: 'idle_prompt',
};
const untypedNotification: CanonicalHookEvent = {
  kind: 'status',
  type: 'notification',
};

beforeEach(() => {
  __resetAgentStatusForTests();
  // mockReset (not mockClear): the "never throws" test replaces the
  // implementation with a throwing one and it must not leak into later tests.
  harness.publish.mockReset().mockImplementation(() => true);
  harness.agentInfo.mockReset().mockReturnValue(null);
  harness.state = 'idle';
});

describe('semanticStatusForEvent (pure mapping)', () => {
  it('maps the documented transition table', () => {
    expect(semanticStatusForEvent(start)).toBe('working');
    expect(semanticStatusForEvent(stop)).toBe('completed');
    expect(semanticStatusForEvent(failure)).toBe('error');
    expect(semanticStatusForEvent(permission)).toBe('awaiting-input');
    expect(semanticStatusForEvent(elicitation)).toBe('awaiting-input');
    expect(semanticStatusForEvent(idlePrompt)).toBe('idle');
    expect(semanticStatusForEvent(untypedNotification)).toBe('idle');
  });

  it('ignores events without status content', () => {
    expect(
      semanticStatusForEvent({ kind: 'session', providerSessionId: 's1' }),
    ).toBeNull();
    expect(semanticStatusForEvent({ kind: 'ignore' })).toBeNull();
  });
});

describe('paneStateForStatus', () => {
  it('only working pins the pane busy', () => {
    expect(paneStateForStatus('working')).toBe('busy');
    expect(paneStateForStatus('completed')).toBe('idle');
    expect(paneStateForStatus('awaiting-input')).toBe('idle');
    expect(paneStateForStatus('error')).toBe('idle');
    expect(paneStateForStatus('idle')).toBe('idle');
  });
});

describe('applyCanonicalHookEvent', () => {
  it('applies start → working, persists per pane and publishes busy', () => {
    harness.agentInfo.mockReturnValue({ paneId: 'pane-1' });

    const result = applyCanonicalHookEvent({ sessionId: 'pty-1', event: start });

    expect(result).toMatchObject({ applied: true, transitioned: true });
    expect(getAgentSemanticStatus('pane-1')).toMatchObject({
      status: 'working',
      paneId: 'pane-1',
      sessionId: 'pty-1',
    });
    expect(harness.publish).toHaveBeenCalledWith('pty-1', 'busy');
  });

  it('walks the full lifecycle working → awaiting-input → working → completed', () => {
    const transitions: string[] = [];
    tapAgentSemanticStatus((entry) => transitions.push(entry.status));

    applyCanonicalHookEvent({ sessionId: 'pty-1', event: userSubmit });
    applyCanonicalHookEvent({ sessionId: 'pty-1', event: permission });
    applyCanonicalHookEvent({ sessionId: 'pty-1', event: userSubmit });
    applyCanonicalHookEvent({ sessionId: 'pty-1', event: stop });

    expect(transitions).toEqual(['working', 'awaiting-input', 'working', 'completed']);
    expect(getAgentSemanticStatus('pty-1')?.status).toBe('completed');
    expect(harness.publish).toHaveBeenLastCalledWith('pty-1', 'idle');
  });

  it('keeps a permission latch across parallel non-interactive tool starts', () => {
    applyCanonicalHookEvent({ sessionId: 'pty-1', event: permission });
    applyCanonicalHookEvent({ sessionId: 'pty-1', event: start });

    expect(getAgentSemanticStatus('pty-1')?.status).toBe('awaiting-input');
    expect(isSessionInjectableIdle('pty-1')).toBe(false);

    applyCanonicalHookEvent({ sessionId: 'pty-1', event: userSubmit });
    expect(getAgentSemanticStatus('pty-1')?.status).toBe('working');
    harness.state = 'busy';
    expect(isSessionInjectableIdle('pty-1')).toBe(false);
    applyCanonicalHookEvent({ sessionId: 'pty-1', event: stop });
    harness.state = 'idle';
    expect(isSessionInjectableIdle('pty-1')).toBe(true);
  });

  it('does not let an unrelated idle notification clear a permission latch', () => {
    applyCanonicalHookEvent({ sessionId: 'pty-1', event: permission });
    applyCanonicalHookEvent({ sessionId: 'pty-1', event: idlePrompt });

    expect(getAgentSemanticStatus('pty-1')?.status).toBe('awaiting-input');
    expect(isSessionInjectableIdle('pty-1')).toBe(false);
  });

  it('fires transition taps only on CHANGE — hook re-asserts are silent', () => {
    const transitions: string[] = [];
    tapAgentSemanticStatus((entry) => transitions.push(entry.status));

    applyCanonicalHookEvent({ sessionId: 'pty-1', event: start });
    const second = applyCanonicalHookEvent({ sessionId: 'pty-1', event: start });
    const third = applyCanonicalHookEvent({ sessionId: 'pty-1', event: start });

    expect(second.transitioned).toBe(false);
    expect(third.transitioned).toBe(false);
    expect(transitions).toEqual(['working']);
    // …but the pane channel is still re-asserted every time (watchdog re-arm).
    expect(harness.publish).toHaveBeenCalledTimes(3);
  });

  it('maps error to the error status while releasing the pane to idle', () => {
    applyCanonicalHookEvent({ sessionId: 'pty-1', event: start });
    applyCanonicalHookEvent({ sessionId: 'pty-1', event: failure });

    expect(getAgentSemanticStatus('pty-1')?.status).toBe('error');
    expect(harness.publish).toHaveBeenLastCalledWith('pty-1', 'idle');
  });

  it('drops session/ignore events without touching state', () => {
    const result = applyCanonicalHookEvent({
      sessionId: 'pty-1',
      event: { kind: 'session', providerSessionId: 'claude-abc' },
    });

    expect(result).toEqual({ applied: false, transitioned: false, entry: null });
    expect(getAgentSemanticStatus('pty-1')).toBeNull();
    expect(harness.publish).not.toHaveBeenCalled();
  });

  it('never throws — a reducer failure degrades to applied:false', () => {
    harness.publish.mockImplementation(() => {
      throw new Error('pty layer exploded');
    });

    const result = applyCanonicalHookEvent({ sessionId: 'pty-1', event: start });

    expect(result.applied).toBe(false);
  });
});

describe('resetAgentStatusOnExit', () => {
  it('resets a stuck working pane to idle on PTY exit (no stop hook)', () => {
    harness.agentInfo.mockReturnValue({ paneId: 'pane-9' });
    const transitions: string[] = [];
    tapAgentSemanticStatus((entry) => transitions.push(entry.status));

    applyCanonicalHookEvent({ sessionId: 'pty-9', event: start });
    expect(getAgentSemanticStatus('pane-9')?.status).toBe('working');

    resetAgentStatusOnExit('pty-9');

    expect(getAgentSemanticStatus('pane-9')).toBeNull();
    expect(transitions).toEqual(['working', 'idle']);
  });

  it('is a no-op for sessions that never reported a hook status', () => {
    const transitions: string[] = [];
    tapAgentSemanticStatus((entry) => transitions.push(entry.status));

    resetAgentStatusOnExit('pty-unknown');

    expect(transitions).toEqual([]);
    expect(getAgentSemanticStatus('pty-unknown')).toBeNull();
  });

  it('does not re-fire taps when the pane already settled to idle', () => {
    const transitions: string[] = [];
    tapAgentSemanticStatus((entry) => transitions.push(entry.status));

    applyCanonicalHookEvent({ sessionId: 'pty-1', event: start });
    applyCanonicalHookEvent({ sessionId: 'pty-1', event: stop });
    resetAgentStatusOnExit('pty-1');

    // stop → completed, exit → idle: both are real transitions.
    expect(transitions).toEqual(['working', 'completed', 'idle']);
    resetAgentStatusOnExit('pty-1');
    expect(transitions).toEqual(['working', 'completed', 'idle']);
  });
});
