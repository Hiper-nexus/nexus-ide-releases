import { describe, expect, it } from 'vitest';
import { shouldOfferLiveMicFrame } from './live-mic-offer-gate';

describe('shouldOfferLiveMicFrame', () => {
  it('blocks provider playback even when the renderer FSM already drifted from speaking', () => {
    expect(
      shouldOfferLiveMicFrame({
        realtimeActive: true,
        localAudioAudible: false,
        providerPlaybackRemainingMs: 2_000,
        status: 'idle',
      }),
    ).toBe(false);
  });

  it('blocks local playback and explicit speaking state', () => {
    expect(
      shouldOfferLiveMicFrame({
        realtimeActive: true,
        localAudioAudible: true,
        providerPlaybackRemainingMs: 0,
        status: 'listening',
      }),
    ).toBe(false);
    expect(
      shouldOfferLiveMicFrame({
        realtimeActive: true,
        localAudioAudible: false,
        providerPlaybackRemainingMs: 0,
        status: 'speaking',
      }),
    ).toBe(false);
  });

  it('offers mic only in an active quiet listening window', () => {
    expect(
      shouldOfferLiveMicFrame({
        realtimeActive: true,
        localAudioAudible: false,
        providerPlaybackRemainingMs: 0,
        status: 'listening',
      }),
    ).toBe(true);
    expect(
      shouldOfferLiveMicFrame({
        realtimeActive: false,
        localAudioAudible: false,
        providerPlaybackRemainingMs: 0,
        status: 'listening',
      }),
    ).toBe(false);
  });
});
