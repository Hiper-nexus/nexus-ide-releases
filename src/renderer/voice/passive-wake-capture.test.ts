import { describe, expect, it } from 'vitest';
import { PassiveWakeCapture } from './passive-wake-capture';

const SAMPLE_RATE = 16_000;
const FRAME = new Float32Array(1_600).fill(0.1); // 100 ms
const SILENCE = new Float32Array(1_600);

describe('PassiveWakeCapture', () => {
  it('returns a bounded speech burst after silence', () => {
    const capture = new PassiveWakeCapture({
      rawSpeechRms: 0.008,
      minSpeechMs: 200,
      silenceMs: 300,
      maxMs: 2_000,
      cooldownMs: 1_000,
    });
    const preRoll = [new Float32Array(800).fill(0.01)];

    expect(capture.offer({ frame: FRAME, rawRms: 0.02, now: 0, sampleRate: SAMPLE_RATE, preRoll })).toBeNull();
    expect(capture.offer({ frame: FRAME, rawRms: 0.02, now: 100, sampleRate: SAMPLE_RATE, preRoll: [] })).toBeNull();
    expect(capture.offer({ frame: SILENCE, rawRms: 0.001, now: 200, sampleRate: SAMPLE_RATE, preRoll: [] })).toBeNull();
    const done = capture.offer({ frame: SILENCE, rawRms: 0.001, now: 400, sampleRate: SAMPLE_RATE, preRoll: [] });

    expect(done?.speechMs).toBe(200);
    expect(done?.frames).toHaveLength(5);
    expect(done?.trailingSilenceMs).toBe(300);
    expect(capture.isActive()).toBe(false);
  });

  it('does not repeatedly submit the same room noise during cooldown', () => {
    const capture = new PassiveWakeCapture({
      rawSpeechRms: 0.008,
      minSpeechMs: 100,
      silenceMs: 100,
      maxMs: 1_000,
      cooldownMs: 500,
    });

    capture.offer({ frame: FRAME, rawRms: 0.02, now: 0, sampleRate: SAMPLE_RATE, preRoll: [] });
    const done = capture.offer({ frame: SILENCE, rawRms: 0.001, now: 100, sampleRate: SAMPLE_RATE, preRoll: [] });
    expect(done).not.toBeNull();
    expect(capture.offer({ frame: FRAME, rawRms: 0.02, now: 300, sampleRate: SAMPLE_RATE, preRoll: [] })).toBeNull();
    expect(capture.isActive()).toBe(false);
  });

  it('drops a short noise burst when the hard capture limit is reached', () => {
    const capture = new PassiveWakeCapture({
      rawSpeechRms: 0.008,
      minSpeechMs: 300,
      silenceMs: 250,
      maxMs: 500,
      cooldownMs: 500,
      forceEmitMinPeakRms: 0.04,
    });

    expect(capture.offer({ frame: FRAME, rawRms: 0.02, now: 0, sampleRate: SAMPLE_RATE, preRoll: [] })).toBeNull();
    expect(capture.offer({ frame: SILENCE, rawRms: 0.001, now: 500, sampleRate: SAMPLE_RATE, preRoll: [] })).toBeNull();
    expect(capture.isActive()).toBe(false);

    expect(capture.offer({ frame: FRAME, rawRms: 0.02, now: 600, sampleRate: SAMPLE_RATE, preRoll: [] })).toBeNull();
    expect(capture.isActive()).toBe(false);
  });

  it('force-emits loud continuous speech at max (Jarvis without silence gap)', () => {
    const capture = new PassiveWakeCapture({
      rawSpeechRms: 0.008,
      minSpeechMs: 200,
      silenceMs: 300,
      maxMs: 500,
      cooldownMs: 500,
      forceEmitMinPeakRms: 0.04,
    });

    expect(capture.offer({ frame: FRAME, rawRms: 0.08, now: 0, sampleRate: SAMPLE_RATE, preRoll: [] })).toBeNull();
    expect(capture.offer({ frame: FRAME, rawRms: 0.08, now: 100, sampleRate: SAMPLE_RATE, preRoll: [] })).toBeNull();
    expect(capture.offer({ frame: FRAME, rawRms: 0.08, now: 200, sampleRate: SAMPLE_RATE, preRoll: [] })).toBeNull();
    expect(capture.offer({ frame: FRAME, rawRms: 0.08, now: 300, sampleRate: SAMPLE_RATE, preRoll: [] })).toBeNull();
    // durationMs = now - started + frameMs → 400 + 100 = 500 = maxMs
    const done = capture.offer({
      frame: FRAME,
      rawRms: 0.08,
      now: 400,
      sampleRate: SAMPLE_RATE,
      preRoll: [],
    });

    expect(done).not.toBeNull();
    expect(done?.forcedByMax).toBe(true);
    expect(done!.speechMs).toBeGreaterThanOrEqual(200);
    expect(capture.isActive()).toBe(false);
  });

  it('still drops quiet ambient that only reaches max without peak speech', () => {
    const capture = new PassiveWakeCapture({
      rawSpeechRms: 0.008,
      minSpeechMs: 200,
      silenceMs: 300,
      maxMs: 500,
      cooldownMs: 500,
      forceEmitMinPeakRms: 0.05,
    });

    // Continuous low energy just above hangover — never peaks.
    for (let t = 0; t <= 500; t += 100) {
      capture.offer({
        frame: FRAME,
        rawRms: 0.015,
        now: t,
        sampleRate: SAMPLE_RATE,
        preRoll: [],
      });
    }
    expect(capture.isActive()).toBe(false);
  });
});
