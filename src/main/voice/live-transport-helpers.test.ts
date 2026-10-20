import { describe, expect, it } from 'vitest';
import {
  buildRealtimeFailure,
  classifyRealtimeConnectError,
  httpStatusFromMessage,
  isIgnorableRealtimeError,
  isLocalToolCallId,
  isScreenContext,
  localToolCallId,
  noCandidateCategory,
  trimLiveHistory,
  buildResumeContext,
  MAX_LIVE_HISTORY_ENTRY_CHARS,
  MAX_RESUME_CONTEXT_CHARS,
} from './live-transport-helpers';

describe('classifyRealtimeConnectError', () => {
  // As mensagens abaixo são as que o runtime REAL produz (openai-realtime.ts):
  // o handshake recusado chega como "Unexpected server response: NNN" do `ws`, o
  // timeout e o fechamento pré-setup têm frases próprias do provider.
  it('classifica recusa de credencial', () => {
    expect(
      classifyRealtimeConnectError(new Error('Unexpected server response: 401')).category,
    ).toBe('auth_rejected');
    expect(
      classifyRealtimeConnectError(new Error('Unexpected server response: 403')).category,
    ).toBe('auth_rejected');
    expect(
      classifyRealtimeConnectError(new Error('Incorrect API key provided')).category,
    ).toBe('auth_rejected');
  });

  it('classifica modelo rejeitado e extrai o status', () => {
    const result = classifyRealtimeConnectError(
      new Error('Unexpected server response: 404'),
    );
    expect(result.category).toBe('model_rejected');
    expect(result.status).toBe(404);
    expect(
      classifyRealtimeConnectError({ message: 'The model grok-voice-x does not exist' }).category,
    ).toBe('model_rejected');
    // 400 só é modelo quando a mensagem fala de modelo.
    expect(
      classifyRealtimeConnectError(new Error('Unexpected server response: 400')).category,
    ).toBe('provider_error');
  });

  it('classifica timeout e fechamento antes do setup', () => {
    expect(
      classifyRealtimeConnectError(new Error('OpenAI realtime setup timeout')).category,
    ).toBe('timeout');
    expect(
      classifyRealtimeConnectError(
        new Error('OpenAI realtime socket closed before setup'),
      ).category,
    ).toBe('closed_before_setup');
  });

  it('classifica erro de rede e o resto como provider_error', () => {
    expect(
      classifyRealtimeConnectError(new Error('connect ECONNREFUSED 104.18.1.1:443')).category,
    ).toBe('network');
    expect(
      classifyRealtimeConnectError(new Error('getaddrinfo ENOTFOUND api.x.ai')).category,
    ).toBe('network');
    expect(classifyRealtimeConnectError(new Error('algo estranho')).category).toBe(
      'provider_error',
    );
  });

  it('nunca devolve o texto do erro, só categoria e status', () => {
    const result = classifyRealtimeConnectError(
      new Error('rejeitou a chave xai-SECRET-123456 com payload gigante'),
    );
    expect(Object.keys(result).sort()).toEqual(['category', 'status']);
    expect(JSON.stringify(result)).not.toContain('SECRET');
  });

  it('lê o status HTTP das duas formas que o provedor escreve', () => {
    expect(httpStatusFromMessage('Unexpected server response: 429')).toBe(429);
    expect(httpStatusFromMessage('status 503')).toBe(503);
    expect(httpStatusFromMessage('sem status aqui')).toBeUndefined();
    // Número fora da faixa HTTP não vira status.
    expect(httpStatusFromMessage('response 9999')).toBeUndefined();
  });

  it('separa "sem chave" de "chave que não decifra"', () => {
    expect(noCandidateCategory(false)).toBe('no_key');
    expect(noCandidateCategory(true)).toBe('vault_unreadable');
  });

  it('buildRealtimeFailure só carrega campo presente (sem undefined solto)', () => {
    const failure = buildRealtimeFailure('timeout', 'grok', 1234, {
      model: 'grok-voice-3.0',
    });
    expect(failure).toEqual({
      category: 'timeout',
      provider: 'grok',
      model: 'grok-voice-3.0',
      attempts: 1,
      at: 1234,
    });
    expect('status' in buildRealtimeFailure('no_key', null, 1)).toBe(false);
  });
});

describe('live-transport-helpers', () => {
  it('classifies wake/reconexão as non-screen context', () => {
    expect(isScreenContext('[wake] diga Olá')).toBe(false);
    expect(isScreenContext('[reconexão] Histórico')).toBe(false);
    expect(isScreenContext('Tela: 3 panes')).toBe(true);
  });

  it('detects local tool call ids', () => {
    expect(isLocalToolCallId(localToolCallId('end', 1))).toBe(true);
    expect(isLocalToolCallId('call_abc')).toBe(false);
  });

  it('ignores benign realtime cancel errors', () => {
    expect(isIgnorableRealtimeError('Cancellation failed: no active response')).toBe(true);
    expect(isIgnorableRealtimeError('OpenAI realtime socket closed')).toBe(false);
  });

  it('ignores the empty commit that follows an already-closed VAD segment', () => {
    expect(isIgnorableRealtimeError('input_audio_buffer_commit_empty')).toBe(true);
    expect(
      isIgnorableRealtimeError(
        'Error committing input audio buffer: buffer too small. Expected at least 100ms of audio.',
      ),
    ).toBe(true);
    // Sem a marca de buffer vazio, erro de verdade continua visível.
    expect(isIgnorableRealtimeError('invalid session.update: unknown field')).toBe(false);
  });

  it('trims complete user turns and never starts resume history with assistant', () => {
    const history = [
      { role: 'assistant' as const, text: 'orphan' },
      { role: 'user' as const, text: 'a' },
      { role: 'assistant' as const, text: 'b' },
      { role: 'user' as const, text: 'c' },
      { role: 'assistant' as const, text: 'd' },
      { role: 'user' as const, text: 'e' },
    ];
    expect(trimLiveHistory(history, 2)).toEqual([
      { role: 'user', text: 'c' },
      { role: 'assistant', text: 'd' },
      { role: 'user', text: 'e' },
    ]);
    expect(buildResumeContext(trimLiveHistory(history, 2))).not.toContain('orphan');
  });

  it('bounds individual history entries and the full resume prompt', () => {
    const huge = 'x'.repeat(MAX_LIVE_HISTORY_ENTRY_CHARS * 10);
    const history = Array.from({ length: 20 }, (_, index) => ({
      role: index % 2 === 0 ? ('user' as const) : ('assistant' as const),
      text: huge,
    }));
    const trimmed = trimLiveHistory(history, 10);
    expect(trimmed.every((entry) => entry.text.length <= MAX_LIVE_HISTORY_ENTRY_CHARS)).toBe(true);
    expect(buildResumeContext(trimmed)?.length).toBeLessThanOrEqual(
      MAX_RESUME_CONTEXT_CHARS,
    );
  });
});

describe('invalidToolResultCallId', () => {
  it('recupera o callId de um resultado recusado para fechar a chamada com erro', async () => {
    const { invalidToolResultCallId } = await import('./live-transport-helpers');
    expect(invalidToolResultCallId({ callId: ' call_9 ', summary: 'x'.repeat(9_999) })).toBe('call_9');
    expect(invalidToolResultCallId({ callId: '' })).toBeNull();
    expect(invalidToolResultCallId({ callId: 'x'.repeat(300) })).toBeNull();
    expect(invalidToolResultCallId({ callId: 7 })).toBeNull();
    expect(invalidToolResultCallId(null)).toBeNull();
    expect(invalidToolResultCallId('call_1')).toBeNull();
  });
});
