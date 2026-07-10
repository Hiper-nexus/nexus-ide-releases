import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const captureSource = fs.readFileSync(path.join(__dirname, 'voice-capture.ts'), 'utf-8');
const controllerSource = fs.readFileSync(path.join(__dirname, 'voice-controller.ts'), 'utf-8');
const finishSource = fs.readFileSync(
  path.join(__dirname, 'voice-finish-and-process.ts'),
  'utf-8',
);

describe('VoiceCapture realtime streaming', () => {
  it('exposes processed mic frames to the realtime transport', () => {
    expect(captureSource).toContain(
      'onFrame: ((frame: Float32Array, sampleRate: number) => void) | null = null',
    );
    expect(captureSource).toContain('this.onFrame?.(frame, this.inputSampleRate)');
  });

  it('wires both capture backends to the same realtime frame forwarder', () => {
    expect(controllerSource).toContain('const streamLiveMicFrame =');
    expect(controllerSource).toContain('capture.current.onFrame = streamLiveMicFrame');
    expect(controllerSource).toContain('wakeMic.setUtteranceFrameTap(streamLiveMicFrame)');
  });

  it('commits the paused realtime audio stream before waiting for a transcript', () => {
    const stopAt = finishSource.indexOf('await capture.stop()');
    const endAt = finishSource.indexOf('liveEndUserAudio();');
    const waitAt = finishSource.indexOf('realtimeTranscriptWaiter.wait(');

    expect(stopAt).toBeGreaterThanOrEqual(0);
    expect(endAt).toBeGreaterThan(stopAt);
    expect(waitAt).toBeGreaterThan(endAt);
  });
});
