import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ObserverFrame, ObserverFrameInput } from '../../shared/observer-frame';
import {
  OBSERVER_MAX_SESSIONS,
  OBSERVER_RING_CAP,
  __resetObserverBusForTests,
  publishObserverFrame,
  snapshotObserverFrames,
  tapObserverFrames,
} from './observer-bus';

function statusInput(
  sessionId: string,
  overrides: Partial<Pick<ObserverFrameBaseLike, 'paneId' | 'at'>> = {},
): ObserverFrameInput {
  return {
    sessionId,
    paneId: overrides.paneId ?? 'pane-1',
    at: overrides.at,
    kind: 'status_changed',
    payload: {
      paneId: overrides.paneId ?? 'pane-1',
      status: 'working',
      previousStatus: null,
      transitioned: true,
    },
  };
}

type ObserverFrameBaseLike = { paneId?: string; at?: number };

function exitInput(sessionId: string): ObserverFrameInput {
  return {
    sessionId,
    kind: 'session_exited',
    payload: { reason: 'pty-exit', lastStatus: null },
  };
}

beforeEach(() => {
  __resetObserverBusForTests();
});

describe('publishObserverFrame — per-session monotonic seq', () => {
  it('assigns seq 1..n per session, independently across sessions', () => {
    const a1 = publishObserverFrame(statusInput('sess-a'));
    const b1 = publishObserverFrame(statusInput('sess-b'));
    const a2 = publishObserverFrame(statusInput('sess-a'));
    const a3 = publishObserverFrame(statusInput('sess-a'));
    const b2 = publishObserverFrame(statusInput('sess-b'));

    expect([a1?.seq, a2?.seq, a3?.seq]).toEqual([1, 2, 3]);
    expect([b1?.seq, b2?.seq]).toEqual([1, 2]);
  });

  it('stamps publish time when `at` is omitted and honors an explicit `at`', () => {
    const before = Date.now();
    const stamped = publishObserverFrame(statusInput('sess-a'));
    const after = Date.now();
    expect(stamped?.at).toBeGreaterThanOrEqual(before);
    expect(stamped?.at).toBeLessThanOrEqual(after);

    const explicit = publishObserverFrame(statusInput('sess-a', { at: 12345 }));
    expect(explicit?.at).toBe(12345);
  });

  it('rejects frames without a sessionId instead of throwing', () => {
    expect(publishObserverFrame(statusInput(''))).toBeNull();
    expect(snapshotObserverFrames('')).toEqual([]);
  });
});

describe('ring buffer — cap and oldest-frame discard', () => {
  it('keeps at most OBSERVER_RING_CAP frames, discarding the oldest', () => {
    const total = OBSERVER_RING_CAP + 25;
    for (let i = 0; i < total; i++) {
      publishObserverFrame(statusInput('sess-ring'));
    }

    const frames = snapshotObserverFrames('sess-ring');
    expect(frames).toHaveLength(OBSERVER_RING_CAP);
    // The 25 oldest were discarded; seq keeps counting past the discard.
    expect(frames[0]?.seq).toBe(26);
    expect(frames[frames.length - 1]?.seq).toBe(total);
  });

  it('snapshot returns a copy — mutating it does not corrupt the ring', () => {
    publishObserverFrame(statusInput('sess-a'));
    const first = snapshotObserverFrames('sess-a');
    first.length = 0;
    expect(snapshotObserverFrames('sess-a')).toHaveLength(1);
  });

  it('snapshot of an unknown session is an empty array', () => {
    expect(snapshotObserverFrames('never-published')).toEqual([]);
  });
});

describe('taps', () => {
  it('delivers every published frame to subscribed taps, in order', () => {
    const seen: ObserverFrame[] = [];
    tapObserverFrames((frame) => seen.push(frame));

    publishObserverFrame(statusInput('sess-a'));
    publishObserverFrame(statusInput('sess-b'));

    expect(seen.map((f) => [f.sessionId, f.seq])).toEqual([
      ['sess-a', 1],
      ['sess-b', 1],
    ]);
  });

  it('unsubscribe stops delivery', () => {
    const seen: ObserverFrame[] = [];
    const untap = tapObserverFrames((frame) => seen.push(frame));
    publishObserverFrame(statusInput('sess-a'));
    untap();
    publishObserverFrame(statusInput('sess-a'));
    expect(seen).toHaveLength(1);
  });

  it('a throwing tap never propagates and never starves other taps', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const seen: number[] = [];
    tapObserverFrames(() => {
      throw new Error('tap exploded');
    });
    tapObserverFrames((frame) => seen.push(frame.seq));

    const frame = publishObserverFrame(statusInput('sess-a'));

    expect(frame?.seq).toBe(1);
    expect(seen).toEqual([1]);
    // The frame still landed in the ring despite the poisoned tap.
    expect(snapshotObserverFrames('sess-a')).toHaveLength(1);
    warn.mockRestore();
  });
});

describe('session bound — least-recently-published eviction', () => {
  it('evicts the coldest session once OBSERVER_MAX_SESSIONS is exceeded', () => {
    for (let i = 0; i < OBSERVER_MAX_SESSIONS; i++) {
      publishObserverFrame(statusInput(`sess-${i}`));
    }
    // Touch sess-0 so it becomes the hottest session.
    publishObserverFrame(statusInput('sess-0'));

    publishObserverFrame(statusInput('sess-overflow'));

    // sess-1 (now the coldest) was evicted; sess-0 survived its touch.
    expect(snapshotObserverFrames('sess-1')).toEqual([]);
    expect(snapshotObserverFrames('sess-0')).toHaveLength(2);
    expect(snapshotObserverFrames('sess-overflow')).toHaveLength(1);
  });

  it('evicts an already-exited session before a live but silent one', () => {
    // sess-live is the coldest by publication time, but it never died.
    publishObserverFrame(statusInput('sess-live'));
    publishObserverFrame(exitInput('sess-dead'));
    for (let i = 0; i < OBSERVER_MAX_SESSIONS - 2; i++) {
      publishObserverFrame(statusInput(`filler-${i}`));
    }

    publishObserverFrame(statusInput('sess-overflow'));

    expect(snapshotObserverFrames('sess-dead')).toEqual([]);
    expect(snapshotObserverFrames('sess-live')).toHaveLength(1);
  });

  it('a session that frames again after exiting stops being the eviction victim', () => {
    publishObserverFrame(statusInput('sess-live'));
    publishObserverFrame(exitInput('sess-resumed'));
    // The pane came back on the same physical session id: it is alive again.
    publishObserverFrame(statusInput('sess-resumed'));
    for (let i = 0; i < OBSERVER_MAX_SESSIONS - 2; i++) {
      publishObserverFrame(statusInput(`filler-${i}`));
    }

    publishObserverFrame(statusInput('sess-overflow'));

    // No ended session left → the coldest (sess-live) is the victim again.
    expect(snapshotObserverFrames('sess-live')).toEqual([]);
    expect(snapshotObserverFrames('sess-resumed')).toHaveLength(2);
  });
});

describe('seq monotonicity survives eviction', () => {
  it('a session revived after eviction resumes its seq instead of restarting at 1', () => {
    publishObserverFrame(statusInput('sess-old'));
    publishObserverFrame(statusInput('sess-old'));
    for (let i = 0; i < OBSERVER_MAX_SESSIONS; i++) {
      publishObserverFrame(statusInput(`filler-${i}`));
    }
    // The ring is gone (replay is best-effort) …
    expect(snapshotObserverFrames('sess-old')).toEqual([]);

    const revived = publishObserverFrame(statusInput('sess-old'));

    // … but seq never goes backwards: the consumer reads a gap (2 → 3 here is
    // contiguous; a dropped frame would show as a jump), never a replay of
    // seq 1 that would look like a brand-new session.
    expect(revived?.seq).toBe(3);
  });

  it('keeps seq counters independent per evicted session', () => {
    publishObserverFrame(statusInput('sess-a'));
    publishObserverFrame(statusInput('sess-a'));
    publishObserverFrame(statusInput('sess-a'));
    publishObserverFrame(statusInput('sess-b'));
    for (let i = 0; i < OBSERVER_MAX_SESSIONS; i++) {
      publishObserverFrame(statusInput(`filler-${i}`));
    }

    expect(publishObserverFrame(statusInput('sess-b'))?.seq).toBe(2);
    expect(publishObserverFrame(statusInput('sess-a'))?.seq).toBe(4);
  });
});
