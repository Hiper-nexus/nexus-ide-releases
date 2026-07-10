import { describe, expect, it } from 'vitest';
import { liveSmokeFailureMessage } from './voice-settings-helpers';

describe('liveSmokeFailureMessage', () => {
  it('names the configured provider key when realtime is unavailable', () => {
    expect(
      liveSmokeFailureMessage('realtime_unavailable', 'gemini-live'),
    ).toContain('GEMINI_API_KEY');
    expect(
      liveSmokeFailureMessage('realtime_unavailable', 'openai-realtime'),
    ).toContain('OPENAI_API_KEY');
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
