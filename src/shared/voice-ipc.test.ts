import { describe, expect, it } from 'vitest';
import { jarvisLiveAudioPlaybackEventSchema } from './voice-ipc';

describe('jarvisLiveAudioPlaybackEventSchema', () => {
  it('accepts a bounded renderer acknowledgement for a main-generated delivery', () => {
    expect(
      jarvisLiveAudioPlaybackEventSchema.safeParse({
        id: '5e04e44e-c77f-40aa-b65d-36d8b693dddf',
        outcome: 'started',
      }).success,
    ).toBe(true);
  });

  it('rejects malformed or widened renderer IPC payloads', () => {
    expect(
      jarvisLiveAudioPlaybackEventSchema.safeParse({
        id: 'not-a-delivery-id',
        outcome: 'started',
      }).success,
    ).toBe(false);
    expect(
      jarvisLiveAudioPlaybackEventSchema.safeParse({
        id: '5e04e44e-c77f-40aa-b65d-36d8b693dddf',
        outcome: 'failed',
        error: 'x'.repeat(281),
      }).success,
    ).toBe(false);
    expect(
      jarvisLiveAudioPlaybackEventSchema.safeParse({
        id: '5e04e44e-c77f-40aa-b65d-36d8b693dddf',
        outcome: 'started',
        injected: true,
      }).success,
    ).toBe(false);
  });
});
