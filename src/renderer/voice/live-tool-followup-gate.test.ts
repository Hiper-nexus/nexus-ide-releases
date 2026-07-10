import { describe, expect, it } from 'vitest';
import { LiveToolFollowUpGate } from './live-tool-followup-gate';

const turn = { sessionId: 'session-1', turnId: 'turn-4', callId: 'call-8' };

describe('LiveToolFollowUpGate', () => {
  it('releases a pending follow-up only for the matching completed tool turn', () => {
    const gate = new LiveToolFollowUpGate<string>();
    expect(gate.arm(turn, 'follow-up')).toBeNull();
    expect(
      gate.complete({ sessionId: 'session-1', turnId: 'turn-3', callId: 'call-8' }),
    ).toBeNull();
    expect(gate.complete(turn)).toBe('follow-up');
  });

  it('does not release a later tool from the same turn for an earlier completion', () => {
    const gate = new LiveToolFollowUpGate<string>();
    expect(gate.arm(turn, 'follow-up')).toBeNull();
    expect(
      gate.complete({ ...turn, callId: 'call-older' }),
    ).toBeNull();
    expect(gate.complete(turn)).toBe('follow-up');
  });

  it('remembers independent early completions until their matching tools arm', () => {
    const gate = new LiveToolFollowUpGate<string>();
    const first = { ...turn, callId: 'call-first' };
    const second = { ...turn, callId: 'call-second' };
    expect(gate.complete(first)).toBeNull();
    expect(gate.complete(second)).toBeNull();
    expect(gate.arm(first, 'first')).toBe('first');
    expect(gate.arm(second, 'second')).toBe('second');
  });

  it('handles provider completion that arrives before the renderer arms', () => {
    const gate = new LiveToolFollowUpGate<string>();
    expect(gate.complete(turn)).toBeNull();
    expect(gate.arm(turn, 'follow-up')).toBe('follow-up');
  });

  it('clears stale completion when a new wake cancels continuity', () => {
    const gate = new LiveToolFollowUpGate<string>();
    gate.complete(turn);
    gate.clear();
    expect(gate.arm(turn, 'follow-up')).toBeNull();
  });
});
