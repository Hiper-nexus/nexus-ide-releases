import { describe, expect, it, vi } from 'vitest';

import { WakeMic } from './wake-mic';

describe('WakeMic realtime pre-roll', () => {
  it('forwards the full captured wake seed to Live (command glued to wake word)', () => {
    const mic = new WakeMic();
    const tap = vi.fn();
    // Four 250ms frames (4000 samples @16kHz) = a 1s seed. Under the old 750ms
    // clip, the first frame — where the command onset lived when wake fired late
    // — was dropped at the renderer and never reached the pendingMic ring, so
    // Gemini only heard the tail ("gritar"). The whole seed must now be tapped.
    const commandOnset = new Float32Array(4_000).fill(0.1);
    const commandBody = new Float32Array(4_000).fill(0.2);
    const commandMid = new Float32Array(4_000).fill(0.3);
    const commandEnd = new Float32Array(4_000).fill(0.4);
    (mic as unknown as { running: boolean }).running = true;
    mic.setUtteranceFrameTap(tap);

    mic.beginUtterance(undefined, 0, [
      commandOnset,
      commandBody,
      commandMid,
      commandEnd,
    ]);

    // Live receives the entire captured wake window, onset first, so a command
    // spoken together with the wake word is preserved end to end. The seed is
    // already time-bounded upstream (WAKE_PREROLL_MS / PASSIVE_WAKE_HANDOFF_MS)
    // and overflow is bounded downstream by the transport's drop-oldest ring.
    expect(tap).toHaveBeenCalledTimes(4);
    expect(tap).toHaveBeenNthCalledWith(1, expect.any(Float32Array), 16_000);
    expect(tap.mock.calls[0][0]).toEqual(commandOnset);
    expect(tap.mock.calls[1][0]).toEqual(commandBody);
    expect(tap.mock.calls[2][0]).toEqual(commandMid);
    expect(tap.mock.calls[3][0]).toEqual(commandEnd);
    mic.cancelUtterance();
  });

  it('caps realtime wake seed at the 2.5s handoff window and drops only stale prefix', () => {
    const mic = new WakeMic();
    const tap = vi.fn();
    // Thirteen 250ms frames = 3.25s. Live must not receive the full historical
    // pre-roll; it should receive the newest 2.5s (10 frames), preserving the
    // command near wake detection while dropping room audio older than the
    // handoff window.
    const frames = Array.from({ length: 13 }, (_, index) =>
      new Float32Array(4_000).fill((index + 1) / 100),
    );
    (mic as unknown as { running: boolean }).running = true;
    mic.setUtteranceFrameTap(tap);

    mic.beginUtterance(undefined, 0, frames);

    expect(tap).toHaveBeenCalledTimes(10);
    expect(tap.mock.calls[0][0]).toEqual(frames[3]);
    expect(tap.mock.calls.at(-1)?.[0]).toEqual(frames[12]);
    mic.cancelUtterance();
  });
});
