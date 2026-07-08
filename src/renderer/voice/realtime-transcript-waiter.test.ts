import { describe, expect, it } from 'vitest';
import { RealtimeTranscriptWaiter } from './realtime-transcript-waiter';

/** Deps com relógio controlado: capturamos o callback do timeout para dispará-lo. */
function fakeDeps() {
  let pendingCb: (() => void) | null = null;
  return {
    deps: {
      setTimeoutFn: (cb: () => void) => {
        pendingCb = cb;
        return 1 as unknown as ReturnType<typeof setTimeout>;
      },
      clearTimeoutFn: () => {
        pendingCb = null;
      },
    },
    fireTimeout: () => {
      const cb = pendingCb;
      pendingCb = null;
      cb?.();
    },
    hasTimer: () => pendingCb !== null,
  };
}

describe('RealtimeTranscriptWaiter (BUG A)', () => {
  it('delivers a real transcript as a NON-mute outcome', async () => {
    const { deps } = fakeDeps();
    const waiter = new RealtimeTranscriptWaiter(deps);
    const p = waiter.wait(4_800);
    expect(waiter.deliver('abre o terminal')).toBe(true);
    await expect(p).resolves.toEqual({ text: 'abre o terminal', superseded: false });
  });

  it('a new wake SUPERSEDES the pending wait — NOT a false mute', async () => {
    // The exact 75ms false-mute bug: a second wake used to resolve the prior
    // wait to null → realtimeMuteDegraded fired long before genuine silence.
    const { deps, fireTimeout } = fakeDeps();
    const waiter = new RealtimeTranscriptWaiter(deps);
    const p = waiter.wait(4_800);
    waiter.supersede(); // new "Hey Jarvis" takes over
    const outcome = await p;
    expect(outcome.superseded).toBe(true);
    expect(outcome.text).toBeNull();
    // The timer was cleared — no late timeout can fire a stale mute.
    fireTimeout();
  });

  it('only a GENUINE timeout yields a mute (superseded:false, text:null)', async () => {
    const { deps, fireTimeout } = fakeDeps();
    const waiter = new RealtimeTranscriptWaiter(deps);
    const p = waiter.wait(4_800);
    fireTimeout(); // the full window elapsed with no transcript = real socket silence
    await expect(p).resolves.toEqual({ text: null, superseded: false });
  });

  it('starting a new wait while one is pending supersedes the old (no re-entrant mute)', async () => {
    // Re-entrancy: a second finishAndProcess starts a new wait — the first must
    // resolve as superseded, never as a null mute.
    const { deps } = fakeDeps();
    const waiter = new RealtimeTranscriptWaiter(deps);
    const first = waiter.wait(4_800);
    const second = waiter.wait(1_200);
    await expect(first).resolves.toEqual({ text: null, superseded: true });
    expect(waiter.deliver('sim')).toBe(true);
    await expect(second).resolves.toEqual({ text: 'sim', superseded: false });
  });

  it('a transcript that arrives before the await is queued and consumed by wait()', async () => {
    const { deps } = fakeDeps();
    const waiter = new RealtimeTranscriptWaiter(deps);
    expect(waiter.deliver('já vou')).toBe(false); // no waiter yet → queued
    expect(waiter.hasQueued()).toBe(true);
    await expect(waiter.wait(4_800)).resolves.toEqual({
      text: 'já vou',
      superseded: false,
    });
    expect(waiter.hasQueued()).toBe(false);
  });

  it('supersede() also drops a queued transcript from the previous turn', async () => {
    const { deps } = fakeDeps();
    const waiter = new RealtimeTranscriptWaiter(deps);
    waiter.deliver('turno velho');
    waiter.supersede();
    expect(waiter.hasQueued()).toBe(false);
  });

  it('resetQueued clears a stray transcript without touching a live wait', () => {
    const { deps } = fakeDeps();
    const waiter = new RealtimeTranscriptWaiter(deps);
    waiter.deliver('lixo');
    waiter.resetQueued();
    expect(waiter.hasQueued()).toBe(false);
  });
});
