const PLAYBACK_DRAIN_THRESHOLD_MS = 80;

export function shouldOfferLiveMicFrame(input: {
  readonly realtimeActive: boolean;
  readonly localAudioAudible: boolean;
  readonly providerPlaybackRemainingMs: number;
  readonly status: string;
}): boolean {
  if (!input.realtimeActive || input.localAudioAudible) return false;
  if (input.status === 'speaking') return false;
  return input.providerPlaybackRemainingMs <= PLAYBACK_DRAIN_THRESHOLD_MS;
}
