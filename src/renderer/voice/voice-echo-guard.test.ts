import { describe, expect, it } from 'vitest';
import {
  buildReplyAutoStop,
  isReplyCapture,
  shouldDiscardSpokenEcho,
  transcriptInConversation,
} from './voice-echo-guard';
import { useVoiceStore } from './voice-store';

describe('voice-echo-guard', () => {
  it('reply capture não usa modo conversa permissivo', () => {
    expect(isReplyCapture('reply')).toBe(true);
    expect(
      transcriptInConversation('reply', 4, Date.now(), 240_000),
    ).toBe(false);
  });

  it('detecta eco contra lastSpoken do store', () => {
    useVoiceStore.getState().setSpoken('Olá patrão, estou aqui no workspace dev.');
    expect(
      shouldDiscardSpokenEcho('estou aqui no workspace dev', 'reply'),
    ).toBe(true);
    useVoiceStore.getState().setSpoken('');
  });

  it('reply auto-stop usa silêncio mais longo que wake', () => {
    const stop = buildReplyAutoStop(() => {});
    expect(stop.silenceMs).toBeGreaterThan(700);
    expect(stop.minListenMs).toBeGreaterThan(1_500);
  });
});
