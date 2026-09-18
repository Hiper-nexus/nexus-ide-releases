import { describe, expect, it } from 'vitest';
import {
  liveSmokeFailureMessage,
  realtimeMissingCredentialMessage,
} from './voice-settings-helpers';

describe('liveSmokeFailureMessage', () => {
  it('names the configured provider key when realtime is unavailable', () => {
    expect(
      liveSmokeFailureMessage('realtime_unavailable', 'gemini-live'),
    ).toContain('GEMINI_API_KEY');
    expect(
      liveSmokeFailureMessage('realtime_unavailable', 'openai-realtime'),
    ).toContain('OPENAI_API_KEY');
    expect(
      liveSmokeFailureMessage('realtime_unavailable', 'grok-realtime'),
    ).toContain('XAI_API_KEY');
  });

  it('tells the HUD that Jarvis is mute without a realtime key', () => {
    const message = realtimeMissingCredentialMessage('grok-realtime');
    expect(message).toContain('XAI_API_KEY');
    expect(message).toContain('OPENAI_API_KEY');
    expect(message).toContain('GEMINI_API_KEY');
    expect(message).toMatch(/não fala/i);
  });

  it('explains connection-without-audio separately from connection failure', () => {
    expect(liveSmokeFailureMessage('no_audio_response', 'gemini-live')).toContain(
      'sem produzir áudio',
    );
    expect(liveSmokeFailureMessage('provider_error', 'gemini-live')).toContain(
      'desconectou',
    );
  });
});

describe('providerOption', () => {
  it('mostra o nome amigável do provider com modelo e disponibilidade', async () => {
    const { providerOption } = await import('./voice-settings-helpers');
    expect(
      providerOption({
        provider: 'xai',
        kind: 'cloud',
        available: true,
        model: 'grok-voice-transcribe-2.0',
        reason: 'ready (XAI_API_KEY)',
      }),
    ).toBe('Grok Voice Transcribe 2.0 (xAI) · grok-voice-transcribe-2.0 · Disponível');
    expect(
      providerOption({
        provider: 'groq',
        kind: 'cloud',
        available: false,
        reason: 'GROQ_API_KEY not set',
      }),
    ).toBe('Groq · Indisponível');
    // Provider desconhecido cai no id cru.
    expect(
      providerOption({
        provider: 'custom-stt',
        kind: 'cloud',
        available: true,
        reason: 'ready',
      }),
    ).toBe('custom-stt · Disponível');
  });
});
