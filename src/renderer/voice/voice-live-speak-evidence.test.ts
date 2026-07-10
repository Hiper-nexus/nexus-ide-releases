import { describe, expect, it } from 'vitest';

import {
  detectLiveSpeakEvidence,
  waitForLiveSpeakEvidence,
  type LiveSpeakEvidenceSnapshot,
} from './voice-live-speak-evidence';

const EMPTY: LiveSpeakEvidenceSnapshot = {
  audioPlayed: 0,
  nativeToolInFlight: 0,
  lastNativeToolAt: 0,
};

describe('Live speak evidence', () => {
  it('accepts played audio or a new native tool, never socket readiness alone', () => {
    expect(detectLiveSpeakEvidence(EMPTY, EMPTY)).toBe('none');
    expect(detectLiveSpeakEvidence(EMPTY, { ...EMPTY, audioPlayed: 1 })).toBe('audio');
    expect(detectLiveSpeakEvidence(EMPTY, { ...EMPTY, lastNativeToolAt: 10 })).toBe('tool');
  });

  it('waits only until the bounded deadline when the provider stays mute', async () => {
    let now = 0;
    const sleeps: number[] = [];
    const evidence = await waitForLiveSpeakEvidence({
      baseline: EMPTY,
      read: () => EMPTY,
      timeoutMs: 90,
      pollMs: 25,
      now: () => now,
      sleep: async (ms) => {
        sleeps.push(ms);
        now += ms;
      },
    });
    expect(evidence).toBe('none');
    expect(sleeps).toEqual([25, 25, 25, 15]);
  });
});
