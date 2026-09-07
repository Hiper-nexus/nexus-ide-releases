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
  applyScreenDetectionEvent,
  getAgentSemanticStatusBySession,
} from '../orch/agent-status';

const start: CanonicalHookEvent = { kind: 'status', type: 'start' };
const stop: CanonicalHookEvent = { kind: 'status', type: 'stop' };

function statusOf(sessionId: string) {
  return getAgentSemanticStatusBySession(sessionId)?.status ?? null;
}

describe('applyScreenDetectionEvent (hook×screen arbitration)', () => {
  beforeEach(() => {
    __resetAgentStatusForTests();
    harness.publish.mockClear();
    harness.agentInfo.mockReturnValue({ paneId: 'pane-1' });
  });

  it('drives hookless sessions directly from the screen', () => {
    const applied = applyScreenDetectionEvent({
      sessionId: 's1',
      state: 'working',
      visibleWorking: true,
      now: 1000,
    });
    expect(applied.applied).toBe(true);
    expect(applied.transitioned).toBe(true);
    expect(statusOf('s1')).toBe('working');
    expect(harness.publish).toHaveBeenCalledWith('s1', 'busy');

    applyScreenDetectionEvent({ sessionId: 's1', state: 'idle', now: 2000 });
    expect(statusOf('s1')).toBe('idle');
    expect(harness.publish).toHaveBeenCalledWith('s1,idle'.split(',')[0], 'idle');
  });

  it('maps blocked to awaiting-input and stamps source=screen', () => {
    const result = applyScreenDetectionEvent({
      sessionId: 's1',
      state: 'blocked',
      visibleBlocker: true,
      now: 1000,
    });
    expect(result.entry?.status).toBe('awaiting-input');
    expect(result.entry?.source).toBe('screen');
  });

  it('unknown applies nothing', () => {
    const result = applyScreenDetectionEvent({ sessionId: 's1', state: 'unknown' });
    expect(result.applied).toBe(false);
    expect(statusOf('s1')).toBeNull();
  });

  it('hook authority wins over the screen', () => {
    applyCanonicalHookEvent({ sessionId: 's1', event: start, now: 1000 });
    expect(statusOf('s1')).toBe('working');

    const result = applyScreenDetectionEvent({
      sessionId: 's1',
      state: 'idle',
      now: 2000,
    });
    expect(result.applied).toBe(false);
    expect(statusOf('s1')).toBe('working');
  });

  it('a fresh visible blocker overrides an older hook report', () => {
    applyCanonicalHookEvent({ sessionId: 's1', event: start, now: 1000 });
    const result = applyScreenDetectionEvent({
      sessionId: 's1',
      state: 'blocked',
      visibleBlocker: true,
      now: 2000,
    });
    expect(result.applied).toBe(true);
    expect(result.transitioned).toBe(true);
    expect(statusOf('s1')).toBe('awaiting-input');
  });

  it('a blocker WITHOUT visible evidence never overrides the hook', () => {
    applyCanonicalHookEvent({ sessionId: 's1', event: start, now: 1000 });
    const result = applyScreenDetectionEvent({
      sessionId: 's1',
      state: 'blocked',
      visibleBlocker: false,
      now: 2000,
    });
    expect(result.applied).toBe(false);
    expect(statusOf('s1')).toBe('working');
  });

  it('a stale blocker (older than the hook report) does not override', () => {
    applyCanonicalHookEvent({ sessionId: 's1', event: start, now: 5000 });
    const result = applyScreenDetectionEvent({
      sessionId: 's1',
      state: 'blocked',
      visibleBlocker: true,
      now: 2000,
    });
    expect(result.applied).toBe(false);
    expect(statusOf('s1')).toBe('working');
  });

  it('no override needed when the hook already reported awaiting-input', () => {
    applyCanonicalHookEvent({
      sessionId: 's1',
      event: {
        kind: 'status',
        type: 'notification',
        notificationType: 'permission_prompt',
      },
      now: 1000,
    });
    expect(statusOf('s1')).toBe('awaiting-input');
    const result = applyScreenDetectionEvent({
      sessionId: 's1',
      state: 'blocked',
      visibleBlocker: true,
      now: 2000,
    });
    expect(result.applied).toBe(false);
    expect(statusOf('s1')).toBe('awaiting-input');
  });

  it('a hook event overrides a screen-sourced latch (no preserve)', () => {
    applyScreenDetectionEvent({
      sessionId: 's1',
      state: 'blocked',
      visibleBlocker: true,
      now: 1000,
    });
    expect(statusOf('s1')).toBe('awaiting-input');
    // A hook `start` must clear the screen latch: hook authority wins.
    applyCanonicalHookEvent({ sessionId: 's1', event: start, now: 2000 });
    expect(statusOf('s1')).toBe('working');
  });

  it('hook stop after screen working settles to completed', () => {
    applyScreenDetectionEvent({ sessionId: 's1', state: 'working', now: 1000 });
    applyCanonicalHookEvent({ sessionId: 's1', event: stop, now: 2000 });
    expect(statusOf('s1')).toBe('completed');
  });
});
