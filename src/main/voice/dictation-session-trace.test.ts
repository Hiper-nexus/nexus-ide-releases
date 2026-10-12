import { describe, expect, it } from 'vitest';
import { dictationSessionTraceEvent } from './dictation-session-trace';

describe('F-1392 — dictationSessionTraceEvent (lista branca do log de uso)', () => {
  it('mantém os metadados e descarta texto, áudio e rótulos com espaço', () => {
    const event = dictationSessionTraceEvent({
      mode: 'code',
      sttProvider: 'groq',
      sttModel: 'gemini-3.5-transcribe',
      language: 'pt',
      audioMs: 1400.4,
      latencyMs: 4187,
      rawChars: 32,
      polishedChars: 19,
      polished: true,
      result: 'ok',
      text: 'vamos comitar isso',
      audioBase64: 'QUJD',
      errorCode: 'frase ditada vazando',
    });
    expect(event).toEqual({
      kind: 'dictation-session',
      mode: 'code',
      sttProvider: 'groq',
      sttModel: 'gemini-3.5-transcribe',
      language: 'pt',
      audioMs: 1400,
      latencyMs: 4187,
      rawChars: 32,
      polishedChars: 19,
      polished: true,
      result: 'ok',
    });
    expect(JSON.stringify(event)).not.toContain('comitar');
  });

  it('F-1393: aceita os resultados queued e pending', () => {
    expect(dictationSessionTraceEvent({ result: 'queued' })).toEqual({ kind: 'dictation-session', result: 'queued' });
    expect(dictationSessionTraceEvent({ result: 'pending' })).toEqual({ kind: 'dictation-session', result: 'pending' });
  });

  it('F-1392 (revisão Fable): aceita modelo org/modelo com / e :', () => {
    expect(
      dictationSessionTraceEvent({ result: 'ok', sttModel: 'org/whisper-large-v3-turbo' })?.sttModel,
    ).toBe('org/whisper-large-v3-turbo');
    expect(
      dictationSessionTraceEvent({ result: 'ok', sttModel: 'groq:whisper-large-v3-turbo' })?.sttModel,
    ).toBe('groq:whisper-large-v3-turbo');
    expect(dictationSessionTraceEvent({ result: 'ok', sttModel: 'modelo com espaco' })?.sttModel)
      .toBeUndefined();
  });

  it('recusa resumo sem resultado válido', () => {
    expect(dictationSessionTraceEvent({ result: 'talvez' })).toBeNull();
    expect(dictationSessionTraceEvent('texto')).toBeNull();
    expect(dictationSessionTraceEvent(null)).toBeNull();
  });
});
