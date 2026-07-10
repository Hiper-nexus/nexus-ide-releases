import { beforeEach, describe, expect, it } from 'vitest';
import type { JarvisLiveToolCancellationEvent } from '../../shared/voice-ipc';
import {
  __resetRealtimeToolExecutions,
  beginRealtimeToolExecution,
  cancelRealtimeToolExecution,
  RealtimeToolCancelledError,
} from './realtime-tool-execution';

function cancellation(
  callId: string,
  reason: JarvisLiveToolCancellationEvent['reason'] = 'provider_cancelled',
): JarvisLiveToolCancellationEvent {
  return {
    sessionId: 'session-1',
    callId,
    reason,
    summary: reason,
    at: 1_000,
  };
}

describe('realtime tool execution registry', () => {
  beforeEach(() => __resetRealtimeToolExecutions());

  it('claims each callId exactly once, including after completion', () => {
    const first = beginRealtimeToolExecution('session-1', 'call-1');
    expect(first.status).toBe('started');
    if (first.status !== 'started') return;
    first.execution.finish();

    expect(beginRealtimeToolExecution('session-1', 'call-1')).toMatchObject({
      status: 'duplicate',
      effectMayHaveCommitted: false,
    });
  });

  it('aborts an in-flight execution and reports whether an effect may exist', () => {
    const claim = beginRealtimeToolExecution('session-1', 'call-2');
    if (claim.status !== 'started') throw new Error('claim failed');
    claim.execution.markEffectMayHaveCommitted();

    expect(cancelRealtimeToolExecution(cancellation('call-2', 'timeout'))).toEqual({
      known: true,
      effectMayHaveCommitted: true,
    });
    expect(() => claim.execution.checkpoint()).toThrowError(
      expect.objectContaining({
        name: 'RealtimeToolCancelledError',
        reason: 'timeout',
        effectMayHaveCommitted: true,
      }) as RealtimeToolCancelledError,
    );
  });

  it('keeps an early cancellation tombstone so a late IPC call never starts', () => {
    expect(cancelRealtimeToolExecution(cancellation('call-early'))).toEqual({
      known: false,
      effectMayHaveCommitted: false,
    });
    expect(beginRealtimeToolExecution('session-1', 'call-early')).toEqual({
      status: 'cancelled',
      effectMayHaveCommitted: false,
    });
  });

  it('allows the provider to reuse a callId in a genuinely new Live session', () => {
    const oldSession = beginRealtimeToolExecution('session-old', 'call-1');
    expect(oldSession.status).toBe('started');
    if (oldSession.status === 'started') oldSession.execution.finish();

    expect(beginRealtimeToolExecution('session-new', 'call-1').status).toBe('started');
  });
});
