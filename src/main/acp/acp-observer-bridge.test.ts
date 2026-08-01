import { describe, expect, it } from 'vitest';

import {
  acpExitReasonFromError,
  buildSessionExitedFrame,
  buildTurnStartedFrame,
  framesForSessionUpdate,
} from './acp-observer-bridge';
import { AcpClientError } from './acp-client';

describe('acp-observer-bridge', () => {
  const scope = {
    sessionId: 'ses_test',
    paneId: 'pane_test',
    missionId: 'mission_test',
    adapterId: 'claude',
    role: 'worker' as const,
  };

  it('maps idle timeout to acp-timeout exit reason', () => {
    const error = new AcpClientError('idle-timeout', 'silent peer');
    expect(acpExitReasonFromError(error)).toBe('acp-timeout');
  });

  it('maps tool_call update to tool_call and tool_result frames', () => {
    const frames = framesForSessionUpdate(scope, {
      sessionUpdate: 'tool_call',
      toolCallId: 'call-1',
      title: 'grep',
      status: 'pending',
    });
    expect(frames).toHaveLength(1);
    expect(frames[0]?.kind).toBe('tool_call');
    const done = framesForSessionUpdate(scope, {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'call-1',
      status: 'completed',
    });
    expect(done[0]?.kind).toBe('tool_result');
  });

  it('builds session_exited with acp reason', () => {
    const frame = buildSessionExitedFrame(scope, 'acp-shutdown', 'idle');
    expect(frame.kind).toBe('session_exited');
    if (frame.kind === 'session_exited') {
      expect(frame.payload.reason).toBe('acp-shutdown');
    }
  });

  it('builds turn_started with stable turn id', () => {
    const frame = buildTurnStartedFrame(scope, 'turn-2', 2);
    expect(frame.kind).toBe('turn_started');
    if (frame.kind === 'turn_started') {
      expect(frame.payload.turnId).toBe('turn-2');
    }
  });
});
