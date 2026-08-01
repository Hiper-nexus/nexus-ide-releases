// Emission contract: applied canonical hook events flow as typed frames into
// the observer bus (increment 1 of the observability plane distilled from
// block/buzz NIP-AO). Uses the REAL observer-bus; only pty-manager is mocked,
// mirroring agent-status.test.ts.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CanonicalHookEvent } from '../../vendor/emdash/hooks/hooks-types';

const harness = vi.hoisted(() => ({
  publish: vi.fn((_sessionId: string, _state: string) => true),
  state: 'idle' as string | null,
  agentInfo: vi.fn(
    (_sessionId: string): { paneId?: string; missionId?: string } | null => null,
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
  resetAgentStatusOnExit,
} from './agent-status';
import {
  __resetObserverBusForTests,
  snapshotObserverFrames,
} from './observer-bus';

const start: CanonicalHookEvent = { kind: 'status', type: 'start' };
const userSubmit: CanonicalHookEvent = {
  kind: 'status',
  type: 'start',
  clearsAwaitingInput: true,
  promptSubmitted: true,
};
const stop: CanonicalHookEvent = { kind: 'status', type: 'stop' };
const failure: CanonicalHookEvent = { kind: 'status', type: 'error' };
const providerLimitFailure: CanonicalHookEvent = {
  kind: 'status',
  type: 'error',
  message: 'usage limit reached — try again in 12 minutes',
};
const permission: CanonicalHookEvent = {
  kind: 'status',
  type: 'notification',
  notificationType: 'permission_prompt',
};

beforeEach(() => {
  __resetAgentStatusForTests();
  __resetObserverBusForTests();
  harness.publish.mockReset().mockImplementation(() => true);
  harness.agentInfo.mockReset().mockReturnValue(null);
  harness.state = 'idle';
});

describe('status_changed emission (every applied event)', () => {
  it('publishes a status_changed frame carrying pane, statuses and transition', () => {
    harness.agentInfo.mockReturnValue({ paneId: 'pane-1', missionId: 'm-42' });

    applyCanonicalHookEvent({ sessionId: 'pty-1', event: start, now: 500 });

    const frames = snapshotObserverFrames('pty-1');
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({
      seq: 1,
      sessionId: 'pty-1',
      paneId: 'pane-1',
      missionId: 'm-42',
      at: 500,
      kind: 'status_changed',
      payload: {
        paneId: 'pane-1',
        status: 'working',
        previousStatus: null,
        transitioned: true,
      },
    });
  });

  it('marks hook re-asserts as transitioned:false (mutate-in-place refresh)', () => {
    applyCanonicalHookEvent({ sessionId: 'pty-1', event: start });
    applyCanonicalHookEvent({ sessionId: 'pty-1', event: start });

    const statuses = snapshotObserverFrames('pty-1').filter(
      (f) => f.kind === 'status_changed',
    );
    expect(statuses.map((f) => f.payload.transitioned)).toEqual([true, false]);
    expect(statuses[1]?.payload.previousStatus).toBe('working');
  });

  it('carries the notificationType on awaiting-input transitions', () => {
    applyCanonicalHookEvent({ sessionId: 'pty-1', event: permission });

    const [frame] = snapshotObserverFrames('pty-1');
    expect(frame).toMatchObject({
      kind: 'status_changed',
      payload: { status: 'awaiting-input', notificationType: 'permission_prompt' },
    });
  });

  it('emits nothing for session/ignore events (not applied)', () => {
    applyCanonicalHookEvent({
      sessionId: 'pty-1',
      event: { kind: 'session', providerSessionId: 'claude-abc' },
    });
    applyCanonicalHookEvent({ sessionId: 'pty-1', event: { kind: 'ignore' } });

    expect(snapshotObserverFrames('pty-1')).toEqual([]);
  });
});

describe('turn lifecycle emission', () => {
  it('promptSubmitted opens a turn: turn_started before its status_changed', () => {
    applyCanonicalHookEvent({ sessionId: 'pty-1', event: userSubmit, now: 100 });

    const frames = snapshotObserverFrames('pty-1');
    expect(frames.map((f) => f.kind)).toEqual(['turn_started', 'status_changed']);
    expect(frames[0]).toMatchObject({
      turnId: 'turn-1',
      payload: { turnId: 'turn-1', turnSequence: 1 },
    });
    // The turn correlates every later frame of the same session.
    expect(frames[1]?.turnId).toBe('turn-1');
  });

  it('a generic start is not a turn boundary — no turn_started frame', () => {
    applyCanonicalHookEvent({ sessionId: 'pty-1', event: start });
    expect(
      snapshotObserverFrames('pty-1').map((f) => f.kind),
    ).toEqual(['status_changed']);
  });

  it('stop closes the turn: status_changed(completed) then turn_ended', () => {
    applyCanonicalHookEvent({ sessionId: 'pty-1', event: userSubmit });
    applyCanonicalHookEvent({ sessionId: 'pty-1', event: stop });

    const frames = snapshotObserverFrames('pty-1');
    expect(frames.map((f) => f.kind)).toEqual([
      'turn_started',
      'status_changed',
      'status_changed',
      'turn_ended',
    ]);
    expect(frames[3]).toMatchObject({
      kind: 'turn_ended',
      payload: { turnId: 'turn-1', outcome: 'completed' },
    });
  });

  it('error ends the turn with outcome error; without a turn, turnId is null', () => {
    applyCanonicalHookEvent({ sessionId: 'pty-1', event: failure });

    const frames = snapshotObserverFrames('pty-1');
    expect(frames.map((f) => f.kind)).toEqual(['status_changed', 'turn_ended']);
    expect(frames[1]).toMatchObject({
      payload: { turnId: null, outcome: 'error' },
    });
  });

  it('promotes a canonical provider limit into a typed provider_error frame', () => {
    applyCanonicalHookEvent({
      sessionId: 'pty-1',
      event: providerLimitFailure,
      now: 900,
    });

    const frames = snapshotObserverFrames('pty-1');
    expect(frames.map((f) => f.kind)).toEqual([
      'provider_error',
      'status_changed',
      'turn_ended',
    ]);
    expect(frames[0]).toMatchObject({
      at: 900,
      kind: 'provider_error',
      payload: {
        source: 'provider-hook',
        kind: 'rate-limit',
        reason: 'usage limit reached',
        cooldownMs: 12 * 60 * 1000,
      },
    });
  });

  it('turn sequences are monotonic across submissions', () => {
    applyCanonicalHookEvent({ sessionId: 'pty-1', event: userSubmit });
    applyCanonicalHookEvent({ sessionId: 'pty-1', event: stop });
    applyCanonicalHookEvent({ sessionId: 'pty-1', event: userSubmit });

    const turnStarts = snapshotObserverFrames('pty-1').filter(
      (f) => f.kind === 'turn_started',
    );
    expect(turnStarts.map((f) => f.payload.turnSequence)).toEqual([1, 2]);
    expect(turnStarts[1]?.payload.turnId).toBe('turn-2');
  });
});

describe('tool_call / tool_result emission', () => {
  it('tool-use emits tool_call with the tool name and a stable callId', () => {
    applyCanonicalHookEvent({
      sessionId: 'pty-1',
      event: start,
      hook: { eventType: 'tool-use', toolName: 'Bash' },
    });

    const frames = snapshotObserverFrames('pty-1');
    expect(frames.map((f) => f.kind)).toEqual(['tool_call', 'status_changed']);
    expect(frames[0]).toMatchObject({
      payload: { callId: 'call-1', toolName: 'Bash' },
    });
  });

  it('tool-complete pairs with the open call of the same tool (mutate-in-place)', () => {
    applyCanonicalHookEvent({
      sessionId: 'pty-1',
      event: start,
      hook: { eventType: 'tool-use', toolName: 'Bash' },
    });
    applyCanonicalHookEvent({
      sessionId: 'pty-1',
      event: start,
      hook: { eventType: 'tool-use', toolName: 'Edit' },
    });
    applyCanonicalHookEvent({
      sessionId: 'pty-1',
      event: start,
      hook: { eventType: 'tool-complete', toolName: 'Bash' },
    });

    const results = snapshotObserverFrames('pty-1').filter(
      (f) => f.kind === 'tool_result',
    );
    expect(results).toHaveLength(1);
    expect(results[0]?.payload).toEqual({
      callId: 'call-1',
      toolName: 'Bash',
      ok: true,
    });
  });

  it('tool-use-failure emits ok:false', () => {
    applyCanonicalHookEvent({
      sessionId: 'pty-1',
      event: start,
      hook: { eventType: 'tool-use', toolName: 'WebFetch' },
    });
    applyCanonicalHookEvent({
      sessionId: 'pty-1',
      event: start,
      hook: { eventType: 'tool-use-failure', toolName: 'WebFetch' },
    });

    const results = snapshotObserverFrames('pty-1').filter(
      (f) => f.kind === 'tool_result',
    );
    expect(results[0]?.payload).toEqual({
      callId: 'call-1',
      toolName: 'WebFetch',
      ok: false,
    });
  });

  it('a result with no name pairs only when exactly one call is open — honesty over guessing', () => {
    applyCanonicalHookEvent({
      sessionId: 'pty-1',
      event: start,
      hook: { eventType: 'tool-use', toolName: 'Bash' },
    });
    applyCanonicalHookEvent({
      sessionId: 'pty-1',
      event: start,
      hook: { eventType: 'tool-complete' },
    });
    // Two parallel opens → an unnamed result cannot be attributed.
    applyCanonicalHookEvent({
      sessionId: 'pty-1',
      event: start,
      hook: { eventType: 'tool-use', toolName: 'Read' },
    });
    applyCanonicalHookEvent({
      sessionId: 'pty-1',
      event: start,
      hook: { eventType: 'tool-use', toolName: 'Grep' },
    });
    applyCanonicalHookEvent({
      sessionId: 'pty-1',
      event: start,
      hook: { eventType: 'tool-complete' },
    });

    const results = snapshotObserverFrames('pty-1').filter(
      (f) => f.kind === 'tool_result',
    );
    expect(results[0]?.payload).toEqual({ callId: 'call-1', toolName: null, ok: true });
    expect(results[1]?.payload).toEqual({ callId: null, toolName: null, ok: true });
  });
});

describe('session_exited emission', () => {
  it('a PTY exit always frames, carrying the last observed status', () => {
    harness.agentInfo.mockReturnValue({ paneId: 'pane-9', missionId: 'm-7' });
    applyCanonicalHookEvent({ sessionId: 'pty-9', event: start });

    resetAgentStatusOnExit('pty-9', 900);

    const frames = snapshotObserverFrames('pty-9');
    const exited = frames.find((f) => f.kind === 'session_exited');
    expect(exited).toMatchObject({
      sessionId: 'pty-9',
      paneId: 'pane-9',
      at: 900,
      payload: { reason: 'pty-exit', lastStatus: 'working' },
    });
  });

  it('never goes dark: exits frame even for sessions with no hook status', () => {
    resetAgentStatusOnExit('pty-silent', 901);

    const frames = snapshotObserverFrames('pty-silent');
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({
      kind: 'session_exited',
      payload: { reason: 'pty-exit', lastStatus: null },
    });
  });

  it('tool-call pairing state resets on exit — a resumed pane restarts callIds', () => {
    applyCanonicalHookEvent({
      sessionId: 'pty-1',
      event: start,
      hook: { eventType: 'tool-use', toolName: 'Bash' },
    });
    resetAgentStatusOnExit('pty-1');
    applyCanonicalHookEvent({
      sessionId: 'pty-1',
      event: start,
      hook: { eventType: 'tool-use', toolName: 'Bash' },
    });

    const calls = snapshotObserverFrames('pty-1').filter(
      (f) => f.kind === 'tool_call',
    );
    expect(calls.map((f) => f.payload.callId)).toEqual(['call-1', 'call-1']);
  });
});

describe('additivity — the reducer contract is untouched', () => {
  it('a throwing bus tap never propagates into the reducer result', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const bus = await import('./observer-bus');
    bus.tapObserverFrames(() => {
      throw new Error('observer consumer exploded');
    });

    const result = applyCanonicalHookEvent({ sessionId: 'pty-1', event: start });

    expect(result.applied).toBe(true);
    expect(result.entry?.status).toBe('working');
    expect(snapshotObserverFrames('pty-1')).toHaveLength(1);
    warn.mockRestore();
  });

  it('a missionId lookup failure drops attribution, not the frame or the event', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // First call resolves the pane (resolvePaneId); later calls explode.
    harness.agentInfo
      .mockReturnValueOnce({ paneId: 'pane-1' })
      .mockImplementation(() => {
        throw new Error('pty registry unavailable');
      });

    const result = applyCanonicalHookEvent({ sessionId: 'pty-1', event: start });

    expect(result.applied).toBe(true);
    const frames = snapshotObserverFrames('pty-1');
    expect(frames).toHaveLength(1);
    expect(frames[0]?.missionId).toBeUndefined();
    warn.mockRestore();
  });
});
