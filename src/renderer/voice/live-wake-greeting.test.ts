import { describe, expect, it } from 'vitest';
import {
  hasRealtimeProviderAudioAnswer,
  shouldRearmAfterAudioOnly,
} from './live-wake-greeting';

describe('Live wake greeting / provider answer gate', () => {
  it('treats held or already-played Live audio as the provider answer', () => {
    expect(hasRealtimeProviderAudioAnswer({ heldChunks: 1, playedChunks: 0 })).toBe(true);
    expect(hasRealtimeProviderAudioAnswer({ heldChunks: 0, playedChunks: 1 })).toBe(true);
    expect(hasRealtimeProviderAudioAnswer({ heldChunks: 0, playedChunks: 0 })).toBe(false);
  });

  it('does not let an audio-only automatic reply renew continuity forever', () => {
    expect(shouldRearmAfterAudioOnly('reply')).toBe(false);
    expect(shouldRearmAfterAudioOnly('wake')).toBe(true);
    expect(shouldRearmAfterAudioOnly('click')).toBe(true);
  });
});
