import { describe, expect, it } from 'vitest';
import { shouldOfferLiveMicFrame } from './live-mic-offer-gate';

describe('shouldOfferLiveMicFrame', () => {
  it('full-duplex: offers while provider plays and while status is speaking (barge-in)', () => {
    expect(
      shouldOfferLiveMicFrame({
        realtimeActive: true,
        localAudioAudible: false,
        providerPlaybackRemainingMs: 2_000,
        status: 'speaking',
        fullDuplex: true,
      }),
    ).toBe(true);
    expect(
      shouldOfferLiveMicFrame({
        realtimeActive: true,
        localAudioAudible: false,
        providerPlaybackRemainingMs: 0,
        status: 'listening',
        fullDuplex: true,
      }),
    ).toBe(true);
  });

  it('full-duplex: still blocks classic/local TTS only', () => {
    expect(
      shouldOfferLiveMicFrame({
        realtimeActive: true,
        localAudioAudible: true,
        providerPlaybackRemainingMs: 0,
        status: 'listening',
        fullDuplex: true,
      }),
    ).toBe(false);
  });

  it('half-duplex: blocks provider playback and speaking status', () => {
    expect(
      shouldOfferLiveMicFrame({
        realtimeActive: true,
        localAudioAudible: false,
        providerPlaybackRemainingMs: 2_000,
        status: 'idle',
        fullDuplex: false,
      }),
    ).toBe(false);
    expect(
      shouldOfferLiveMicFrame({
        realtimeActive: true,
        localAudioAudible: false,
        providerPlaybackRemainingMs: 0,
        status: 'speaking',
        fullDuplex: false,
      }),
    ).toBe(false);
  });

  it('never offers when realtime turn is inactive', () => {
    expect(
      shouldOfferLiveMicFrame({
        realtimeActive: false,
        localAudioAudible: false,
        providerPlaybackRemainingMs: 0,
        status: 'listening',
        fullDuplex: true,
      }),
    ).toBe(false);
  });
});
