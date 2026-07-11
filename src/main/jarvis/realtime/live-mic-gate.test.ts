import { describe, expect, it } from 'vitest';
import { shouldWithholdLiveMicFrame } from './live-mic-gate';

describe('shouldWithholdLiveMicFrame', () => {
  it('withholds mic while LOCAL TTS/ack is playing (speaking, not provider)', () => {
    expect(
      shouldWithholdLiveMicFrame({ status: 'speaking', providerSpeaking: false }),
    ).toBe(true);
  });

  it('withholds mic during provider audio until an AEC reference path exists', () => {
    expect(
      shouldWithholdLiveMicFrame({ status: 'speaking', providerSpeaking: true }),
    ).toBe(true);
    expect(
      shouldWithholdLiveMicFrame({ status: 'dormant', providerSpeaking: true }),
    ).toBe(true);
  });

  it('does not withhold while listening/thinking/dormant', () => {
    for (const status of ['listening', 'thinking', 'dormant', 'off'] as const) {
      expect(shouldWithholdLiveMicFrame({ status, providerSpeaking: false })).toBe(false);
    }
  });
});
