import { describe, expect, it, vi } from 'vitest';

import { WakeMic, trailingSpeechRun } from './wake-mic';

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

  it('drops pre-wake room audio before the last silence gap in the seed', () => {
    const mic = new WakeMic();
    const tap = vi.fn();
    // 250ms frames @16kHz. Room/TV audio, then a >600ms silence gap, then the
    // wake word + command. Only the trailing speech run must reach Live so
    // Gemini never transcribes the pre-wake ambient ("o mundo aqui. Ei Jarvis").
    const roomA = new Float32Array(4_000).fill(0.3);
    const roomB = new Float32Array(4_000).fill(0.25);
    const gap1 = new Float32Array(4_000).fill(0); // 250ms silence
    const gap2 = new Float32Array(4_000).fill(0); // +250ms
    const gap3 = new Float32Array(4_000).fill(0); // +250ms = 750ms > 600ms gap
    const wakeWord = new Float32Array(4_000).fill(0.2);
    const command = new Float32Array(4_000).fill(0.4);
    (mic as unknown as { running: boolean }).running = true;
    mic.setUtteranceFrameTap(tap);

    mic.beginUtterance(undefined, 0, [
      roomA,
      roomB,
      gap1,
      gap2,
      gap3,
      wakeWord,
      command,
    ]);

    expect(tap).toHaveBeenCalledTimes(2);
    expect(tap.mock.calls[0][0]).toEqual(wakeWord);
    expect(tap.mock.calls[1][0]).toEqual(command);
    mic.cancelUtterance();
  });
});

describe('trailingSpeechRun', () => {
  const rate = 16_000;
  const speech = () => new Float32Array(4_000).fill(0.3);
  const silence = () => new Float32Array(4_000).fill(0);

  it('returns continuous speech unchanged (no gap to cut on)', () => {
    const frames = [speech(), speech(), speech()];
    expect(trailingSpeechRun(frames, rate, 600)).toHaveLength(3);
  });

  it('keeps only the run after the last silence gap >= gapMs', () => {
    // 3 x 250ms silence = 750ms >= 600ms gap.
    const frames = [speech(), silence(), silence(), silence(), speech(), speech()];
    const out = trailingSpeechRun(frames, rate, 600);
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual(frames[4]);
    expect(out[1]).toEqual(frames[5]);
  });

  it('ignores a short pause below gapMs', () => {
    // A single 250ms silence < 600ms must not split the utterance.
    const frames = [speech(), silence(), speech()];
    expect(trailingSpeechRun(frames, rate, 600)).toHaveLength(3);
  });

  it('returns [] for empty input', () => {
    expect(trailingSpeechRun([], rate, 600)).toEqual([]);
  });
});
