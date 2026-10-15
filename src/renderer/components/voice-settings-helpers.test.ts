import { describe, expect, it } from 'vitest';
import {
  liveConnectionView,
  liveSmokeFailureMessage,
  liveSmokeTestOutcomeMessage,
  liveTestErrorMessage,
  realtimeFailureMessage,
  realtimeMissingCredentialMessage,
} from './voice-settings-helpers';
import type {
  JarvisLiveState,
  JarvisLiveSmokeTestResult,
  RealtimeFailure,
} from '../../shared/voice-ipc';

const BASE = {
  transport: 'grok-realtime' as const,
  configured: true,
  classicLive: false,
  realtimeReady: false,
  attempted: true,
};

describe('liveConnectionView', () => {
  it('standby antes de qualquer tentativa: pronto, não "conectando"', () => {
    const view = liveConnectionView({ ...BASE, attempted: false });
    expect(view.tone).toBe('standby');
    expect(view.label).toBe('Pronto — conecta quando você falar');
  });

  it('standby com Live clássico e com Jarvis desligado', () => {
    expect(
      liveConnectionView({ ...BASE, configured: false, classicLive: true }).label,
    ).toBe('Jarvis Live clássico');
    expect(liveConnectionView({ ...BASE, configured: false }).label).toBe(
      'Jarvis em modo manual',
    );
  });

  it('online nomeia a rota que conectou e avisa quando foi degradação', () => {
    const principal = liveConnectionView({
      ...BASE,
      realtimeReady: true,
      connectedProvider: 'grok',
    });
    expect(principal.tone).toBe('online');
    expect(principal.label).toBe('Grok Voice conectado');
    expect(principal.detail).not.toMatch(/não respondeu/);

    // Grok caiu e o Gemini segurou: dizer "Grok Voice conectado" seria mentira.
    const degradado = liveConnectionView({
      ...BASE,
      realtimeReady: true,
      connectedProvider: 'gemini',
    });
    expect(degradado.label).toBe('Gemini Live conectado');
    expect(degradado.detail).toContain('não respondeu');
  });

  it('connecting só aparece com tentativa em andamento', () => {
    expect(liveConnectionView(BASE).tone).toBe('connecting');
  });

  it('error mostra o motivo por categoria, em português', () => {
    const cases: Array<[RealtimeFailure, RegExp]> = [
      [
        { category: 'auth_rejected', provider: 'grok', attempts: 1, at: 1 },
        /Grok Voice recusou a chave/,
      ],
      [
        {
          category: 'model_rejected',
          provider: 'grok',
          model: 'grok-voice-3.0',
          status: 404,
          attempts: 1,
          at: 1,
        },
        /não reconhece o modelo grok-voice-3\.0 \(HTTP 404\)/,
      ],
      [
        { category: 'timeout', provider: 'openai', attempts: 1, at: 1 },
        /OpenAI Realtime não respondeu a tempo/,
      ],
      [
        { category: 'network', provider: 'gemini', attempts: 1, at: 1 },
        /Verifique a conexão/,
      ],
      [
        { category: 'closed_before_setup', provider: 'grok', attempts: 1, at: 1 },
        /fezou a conexão antes de começar|fechou a conexão antes de começar/,
      ],
    ];
    for (const [failure, expected] of cases) {
      const view = liveConnectionView({ ...BASE, failure });
      expect(view.tone).toBe('error');
      expect(view.detail).toMatch(expected);
      expect(view.label).toBe('Grok Voice não conectou');
    }
  });

  it('no-key é tom próprio: falta configuração, não é falha', () => {
    const view = liveConnectionView({
      ...BASE,
      failure: { category: 'no_key', provider: null, attempts: 1, at: 1 },
    });
    expect(view.tone).toBe('no-key');
    expect(view.label).toBe('Grok Voice sem credencial');
    expect(view.detail).toContain('XAI_API_KEY');

    const vault = liveConnectionView({
      ...BASE,
      failure: { category: 'vault_unreadable', provider: 'grok', attempts: 1, at: 1 },
    });
    expect(vault.tone).toBe('no-key');
    expect(vault.detail).toMatch(/não pôde ser lida/);
  });

  it('falha velha não prevalece com o realtime desligado (Classic/manual)', () => {
    const failure: RealtimeFailure = {
      category: 'auth_rejected',
      provider: 'grok',
      attempts: 1,
      at: 1,
    };
    const classic = liveConnectionView({
      ...BASE,
      configured: false,
      classicLive: true,
      failure,
    });
    expect(classic.tone).toBe('standby');
    expect(classic.label).toBe('Jarvis Live clássico');

    const manual = liveConnectionView({ ...BASE, configured: false, failure });
    expect(manual.tone).toBe('standby');
    expect(manual.label).toBe('Jarvis em modo manual');
  });

  it('falha de rota fora da cadeia atual não prevalece após trocar o transporte', () => {
    // Erro do Grok; a pessoa trocou para Gemini Live (cadeia gemini → openai,
    // sem grok). O chip volta ao estado do transporte atual.
    const view = liveConnectionView({
      transport: 'gemini-live',
      configured: true,
      classicLive: false,
      realtimeReady: false,
      attempted: false,
      failure: { category: 'auth_rejected', provider: 'grok', attempts: 1, at: 1 },
    });
    expect(view.tone).toBe('standby');
    expect(view.label).toBe('Pronto — conecta quando você falar');
  });

  it('falha dentro da cadeia atual continua valendo', () => {
    const view = liveConnectionView({
      ...BASE,
      failure: { category: 'auth_rejected', provider: 'grok', attempts: 1, at: 1 },
    });
    expect(view.tone).toBe('error');
    expect(view.detail).toMatch(/Grok Voice recusou a chave/);
  });

  it('uma falha de credencial aponta a cadeia inteira, não só a cabeça', () => {
    const message = realtimeFailureMessage(
      { category: 'no_key', provider: null, attempts: 1, at: 1 },
      'grok-realtime',
    );
    expect(message).toContain('XAI_API_KEY');
    expect(message).toContain('OPENAI_API_KEY');
  });

  it('traduz o erro de escopo do Main para a ação, não para o jargão', () => {
    expect(
      liveTestErrorMessage(
        new Error('voice session requires an authorized project scope'),
      ),
    ).toBe('Abra um projeto para testar a voz.');
    // Mensagem desconhecida passa intacta (o Main pode ter outros motivos).
    expect(liveTestErrorMessage(new Error('socket hang up'))).toBe('socket hang up');
  });
});

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

describe('liveSmokeTestOutcomeMessage', () => {
  const state = (over: Partial<JarvisLiveState> = {}): JarvisLiveState => ({
    enabled: true,
    sessionId: 's1',
    status: 'error',
    realtimeReady: false,
    startedAt: 1,
    lastActiveAt: 1,
    turns: 0,
    pendingMic: false,
    ...over,
  });

  it('sucesso confirma com a latência da tentativa', () => {
    const result: JarvisLiveSmokeTestResult = {
      ok: true,
      evidence: 'audio',
      latencyMs: 42,
      state: state({ status: 'listening', realtimeReady: true }),
    };
    const outcome = liveSmokeTestOutcomeMessage(result, 'grok-realtime');
    expect(outcome.ok).toBe(true);
    expect(outcome.text).toContain('42 ms');
  });

  it('a 1ª falha usa a categoria do estado DEVOLVIDO, não a mensagem genérica', () => {
    // Antes: o botão lia o liveState de antes da tentativa (sem falha) e
    // mostrava "nenhuma rota conectou" mesmo com auth_rejected no resultado.
    const result: JarvisLiveSmokeTestResult = {
      ok: false,
      evidence: 'none',
      latencyMs: null,
      reason: 'realtime_unavailable',
      state: state({
        realtimeFailure: {
          category: 'auth_rejected',
          provider: 'grok',
          status: 401,
          attempts: 1,
          at: 1,
        },
      }),
    };
    const outcome = liveSmokeTestOutcomeMessage(result, 'grok-realtime');
    expect(outcome.ok).toBe(false);
    expect(outcome.text).toMatch(/Grok Voice recusou a chave \(HTTP 401\)/);
  });

  it('sem categoria no estado devolvido, o motivo do smoke decide', () => {
    const result: JarvisLiveSmokeTestResult = {
      ok: false,
      evidence: 'none',
      latencyMs: null,
      reason: 'response_timeout',
      state: state({ realtimeFailure: null }),
    };
    const outcome = liveSmokeTestOutcomeMessage(result, 'gemini-live');
    expect(outcome.ok).toBe(false);
    expect(outcome.text).toContain('não respondeu em 15 segundos');
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
