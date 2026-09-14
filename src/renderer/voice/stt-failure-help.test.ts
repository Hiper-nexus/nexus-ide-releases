import { describe, expect, it } from 'vitest';
import type { TranscribeResult } from '../../shared/voice-ipc';
import {
  describeSttFailure,
  sttProviderLabel,
  sttSuccessNote,
  type SuccessfulTranscribeResult,
} from './stt-failure-help';

function failure(
  attempts: Array<{ provider: string; reason: string }>,
): TranscribeResult {
  return {
    ok: false,
    needsKey: false,
    error: 'No speech-to-text provider succeeded.',
    attempts,
  } as TranscribeResult;
}

describe('describeSttFailure', () => {
  it('aponta a chave ausente e onde corrigir', () => {
    const msg = describeSttFailure(
      failure([
        { provider: 'gemini', reason: 'GEMINI_API_KEY not set' },
        { provider: 'groq', reason: 'GROQ_API_KEY not set' },
      ]),
    );
    expect(msg).toContain('Gemini sem chave');
    expect(msg).toContain('Configurações → Chaves de API');
  });

  it('chave Gemini sem preview sugere a Groq como correção', () => {
    const msg = describeSttFailure(
      failure([
        {
          provider: 'gemini',
          reason:
            'interactions: error (404): model not found; generateContent: empty transcript',
        },
        { provider: 'groq', reason: 'GROQ_API_KEY not set' },
      ]),
    );
    expect(msg).toContain('não tem acesso ao modelo de transcrição');
    expect(msg).toContain('ative a Groq');
  });

  it('429 explica throttle e sugere esperar', () => {
    const msg = describeSttFailure(
      failure([{ provider: 'groq', reason: 'throttled (429 rate limit)' }]),
    );
    expect(msg).toContain('limite de requisições (429)');
    expect(msg).toContain('aguarde');
  });

  it('401 diz chave inválida e onde conferir', () => {
    const msg = describeSttFailure(
      failure([{ provider: 'gemini', reason: 'invalid key (401): bad key' }]),
    );
    expect(msg).toContain('inválida');
    expect(msg).toContain('Chaves de API');
  });

  it('whisper ausente ensina a instalar o fallback local', () => {
    const msg = describeSttFailure(
      failure([
        { provider: 'groq', reason: 'GROQ_API_KEY not set' },
        { provider: 'local-whisper', reason: 'whisper.cpp not found — install' },
      ]),
    );
    expect(msg).toContain('brew install whisper-cpp');
  });

  it('sem attempts cai no erro cru sem quebrar', () => {
    expect(describeSttFailure(failure([]))).toContain('falhou');
  });
});

describe('sttSuccessNote', () => {
  it('nomeia a API que atendeu quando não houve fallback', () => {
    const result = {
      ok: true,
      text: 'commit and push',
      provider: 'gemini',
      attempts: [],
    } as SuccessfulTranscribeResult;
    expect(sttSuccessNote(result)).toBe('Transcrito com Gemini');
  });

  it('prefere a nota de fallback quando houve jornada', () => {
    const result = {
      ok: true,
      text: 'ok',
      provider: 'groq',
      fallbackNote: 'gemini 429 → groq',
      attempts: [],
    } as SuccessfulTranscribeResult;
    expect(sttSuccessNote(result)).toBe('gemini 429 → groq');
  });
});

describe('sttProviderLabel', () => {
  it('mapeia conhecidos e repassa desconhecidos', () => {
    expect(sttProviderLabel('groq')).toBe('Groq');
    expect(sttProviderLabel('local-whisper')).toBe('Whisper local');
    expect(sttProviderLabel('custom-x')).toBe('custom-x');
    expect(sttProviderLabel(undefined)).toBe('STT');
  });
});
