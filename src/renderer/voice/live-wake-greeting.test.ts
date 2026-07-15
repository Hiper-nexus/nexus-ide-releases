import { describe, expect, it } from 'vitest';
import {
  hasRealtimeProviderAudioAnswer,
  liveAnswerOutcomeFromEvidence,
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

describe('live provider answer outcome (anti-mute after final transcript)', () => {
  it('commits to the realtime provider when it produced audio or a native tool', () => {
    expect(liveAnswerOutcomeFromEvidence('audio')).toBe('commit');
    expect(liveAnswerOutcomeFromEvidence('tool')).toBe('commit');
  });

  it('degrades to Classic when the provider stayed silent past the deadline', () => {
    // The core bug: ~89% of final-transcript turns closed with no audio and the
    // code returned into silence. A timeout must now fall back to Classic TTS.
    expect(liveAnswerOutcomeFromEvidence('timeout')).toBe('degrade');
  });

  it('aborts (does nothing) when a newer turn superseded this one', () => {
    expect(liveAnswerOutcomeFromEvidence('superseded')).toBe('abort');
  });
});
