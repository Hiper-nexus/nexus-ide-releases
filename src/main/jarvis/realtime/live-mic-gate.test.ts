import { describe, expect, it } from 'vitest';
import { isFullDuplexTransport, shouldWithholdLiveMicFrame } from './live-mic-gate';

describe('isFullDuplexTransport', () => {
  it('todo transporte realtime é full-duplex (barge-in no VAD do servidor)', () => {
    expect(isFullDuplexTransport('gemini-live')).toBe(true);
    expect(isFullDuplexTransport('grok-realtime')).toBe(true);
    expect(isFullDuplexTransport('openai-realtime')).toBe(true);
  });

  it('classic e valores desconhecidos continuam half-duplex', () => {
    expect(isFullDuplexTransport('classic')).toBe(false);
    expect(isFullDuplexTransport('')).toBe(false);
    expect(isFullDuplexTransport('grok')).toBe(false);
  });
});

describe('shouldWithholdLiveMicFrame', () => {
  it('withholds mic while LOCAL TTS/ack is playing (speaking, not provider)', () => {
    expect(
      shouldWithholdLiveMicFrame({ status: 'speaking', providerSpeaking: false }),
    ).toBe(true);
  });

  it('withholds mic during provider audio in half-duplex', () => {
    expect(
      shouldWithholdLiveMicFrame({ status: 'speaking', providerSpeaking: true }),
    ).toBe(true);
    expect(
      shouldWithholdLiveMicFrame({ status: 'dormant', providerSpeaking: true }),
    ).toBe(true);
  });

  it('keeps mic open during speech in full-duplex (barge-in)', () => {
    expect(
      shouldWithholdLiveMicFrame({
        status: 'speaking',
        providerSpeaking: true,
        fullDuplex: true,
      }),
    ).toBe(false);
    expect(
      shouldWithholdLiveMicFrame({
        status: 'speaking',
        providerSpeaking: false,
        fullDuplex: true,
      }),
    ).toBe(false);
  });

  it('does not withhold while listening/thinking/dormant', () => {
    for (const status of ['listening', 'thinking', 'dormant', 'off'] as const) {
      expect(shouldWithholdLiveMicFrame({ status, providerSpeaking: false })).toBe(false);
    }
  });
});
