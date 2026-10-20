import { describe, expect, it } from 'vitest';
import { SAFE_REALTIME_ACTIONS } from './voice-realtime-actions';
import {
  LIVE_TOOL_RESULT_SUMMARY_MAX,
  jarvisLiveAudioPlaybackEventSchema,
  jarvisLiveToolResultInputSchema,
  speakRequestSchema,
  transcribeRequestSchema,
} from './voice-ipc';

describe('jarvisLiveAudioPlaybackEventSchema', () => {
  it('accepts a bounded renderer acknowledgement for a main-generated delivery', () => {
    expect(
      jarvisLiveAudioPlaybackEventSchema.safeParse({
        id: '5e04e44e-c77f-40aa-b65d-36d8b693dddf',
        outcome: 'started',
      }).success,
    ).toBe(true);
  });

  it('rejects malformed or widened renderer IPC payloads', () => {
    expect(
      jarvisLiveAudioPlaybackEventSchema.safeParse({
        id: 'not-a-delivery-id',
        outcome: 'started',
      }).success,
    ).toBe(false);
    expect(
      jarvisLiveAudioPlaybackEventSchema.safeParse({
        id: '5e04e44e-c77f-40aa-b65d-36d8b693dddf',
        outcome: 'failed',
        error: 'x'.repeat(281),
      }).success,
    ).toBe(false);
    expect(
      jarvisLiveAudioPlaybackEventSchema.safeParse({
        id: '5e04e44e-c77f-40aa-b65d-36d8b693dddf',
        outcome: 'started',
        injected: true,
      }).success,
    ).toBe(false);
  });
});

describe('transcribeRequestSchema', () => {
  const audio = Buffer.from('wav').toString('base64');

  it('allows the bounded passive wake purpose only', () => {
    expect(
      transcribeRequestSchema.safeParse({ audioBase64: audio, purpose: 'passive-wake' }).success,
    ).toBe(true);
    expect(
      transcribeRequestSchema.safeParse({ audioBase64: audio, purpose: 'arbitrary-provider' }).success,
    ).toBe(false);
  });

  it('accepts the container mimes of mission audio attachments', () => {
    for (const mime of ['audio/mpeg', 'audio/mp4', 'audio/ogg', 'audio/flac'] as const) {
      expect(transcribeRequestSchema.safeParse({ audioBase64: audio, mime }).success).toBe(true);
    }
    expect(
      transcribeRequestSchema.safeParse({ audioBase64: audio, mime: 'video/mp4' }).success,
    ).toBe(false);
  });
});

describe('jarvisLiveToolResultInputSchema', () => {
  it.each([
    ['new_agentic_mission', 'modo agêntico aberto'],
    ['open_squad_picker', 'seletor de squads salvos aberto'],
    ['read_current_view', 'visão atual lida'],
  ])('accepts the %s tool result', (tool, summary) => {
    expect(
      jarvisLiveToolResultInputSchema.safeParse({
        source: 'realtime',
        tool,
        ok: true,
        summary,
      }).success,
    ).toBe(true);
  });
});

describe('speakRequestSchema', () => {
  it('aceita preview sem text: a frase da amostra e montada no Main', () => {
    const parsed = speakRequestSchema.safeParse({
      preview: { provider: 'gemini', voice: 'Sulafat' },
    });
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.text).toBeUndefined();
  });

  it('recusa provider fora de gemini/openai (xAI nao tem TTS de amostra)', () => {
    expect(
      speakRequestSchema.safeParse({ preview: { provider: 'xai', voice: 'rex' } }).success,
    ).toBe(false);
    expect(
      speakRequestSchema.safeParse({ preview: { provider: 'gemini', voice: '' } }).success,
    ).toBe(false);
  });

  it('fala normal continua exigindo texto nao vazio', () => {
    expect(speakRequestSchema.safeParse({ text: 'oi' }).success).toBe(true);
    expect(speakRequestSchema.safeParse({ text: '   ' }).success).toBe(false);
    expect(speakRequestSchema.safeParse({}).success).toBe(false);
  });
});

describe('jarvisLiveToolResultInputSchema — resultado nunca some', () => {
  const base = { callId: 'call_1', source: 'realtime' as const, ok: true, summary: 'ok' };

  it('aceita toda ação que o modelo realtime pode pedir (open_agent incluído)', () => {
    for (const tool of SAFE_REALTIME_ACTIONS) {
      expect(jarvisLiveToolResultInputSchema.safeParse({ ...base, tool }).success, tool).toBe(true);
    }
  });

  it('resumo longo é cortado, não recusado (antes o modelo esperava 120 s)', () => {
    const parsed = jarvisLiveToolResultInputSchema.safeParse({
      ...base,
      tool: 'mcp_tool',
      summary: 'x'.repeat(5_000),
    });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.summary.length).toBe(LIVE_TOOL_RESULT_SUMMARY_MAX);
    expect(parsed.data.summary.endsWith('…')).toBe(true);
  });
});
