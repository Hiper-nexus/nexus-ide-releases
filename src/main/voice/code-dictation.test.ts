import { describe, expect, it, vi } from 'vitest';
import { DICTATION_CODE_PRIMING_PROMPT } from '../../shared/dictation-vocabulary';
import type { TranscribeRequest, TranscribeResult } from '../../shared/voice-ipc';
import { finalizeCodeDictation, type CodeDictationPorts } from './code-dictation';

const literalRequest = {
  audioBase64: 'UklGRg==',
  mime: 'audio/wav',
  sampleRate: 16_000,
  translate: false,
  language: 'pt',
  prompt: 'Ditado técnico em português…',
  polish: 'code-prompt',
} as TranscribeRequest;

const literalResult = {
  ok: true,
  text: 'faz o commit e abre o pull request',
  provider: 'gemini',
  attempts: [],
} as unknown as Extract<TranscribeResult, { ok: true }>;

function ports(overrides: Partial<CodeDictationPorts> = {}) {
  const log = vi.fn();
  return {
    log,
    ports: {
      polish: vi.fn(async (text: string) => ({ text, polished: false, reason: 'no key' })),
      transcribe: vi.fn(async () => ({
        ok: true,
        text: 'Commit and open the pull request.',
        provider: 'gemini',
        attempts: [],
      }) as unknown as TranscribeResult),
      log,
      now: () => 1_000,
      ...overrides,
    } satisfies CodeDictationPorts,
  };
}

describe('finalizeCodeDictation', () => {
  it('reescrita ok: entrega o prompt reescrito, sem transcrever de novo', async () => {
    const { ports: p, log } = ports({
      polish: vi.fn(async () => ({ text: 'Commit and open the pull request.', polished: true })),
    });
    const out = await finalizeCodeDictation(literalRequest, literalResult, 900, p);
    expect(out).toMatchObject({ ok: true, text: 'Commit and open the pull request.' });
    expect(p.transcribe).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(
      'info',
      'stt.dictationRaw',
      literalResult.text,
      expect.objectContaining({ polished: true, sttMs: 900, mode: 'code' }),
    );
  });

  it('reescrita falhou no caminho literal: a STT traduz o MESMO áudio — o CODE nunca entrega português', async () => {
    const { ports: p, log } = ports();
    const out = await finalizeCodeDictation(literalRequest, literalResult, 900, p);

    expect(p.transcribe).toHaveBeenCalledOnce();
    expect(p.transcribe).toHaveBeenCalledWith(
      expect.objectContaining({
        audioBase64: literalRequest.audioBase64,
        translate: true,
        prompt: DICTATION_CODE_PRIMING_PROMPT,
      }),
    );
    expect(out).toMatchObject({ ok: true, text: 'Commit and open the pull request.' });
    // O caminho de falha também fica rastreável no voice.log.
    expect(log).toHaveBeenCalledWith(
      'info',
      'stt.dictationRaw',
      literalResult.text,
      expect.objectContaining({
        polished: false,
        final: 'Commit and open the pull request.',
        translateFallback: { ok: true, provider: 'gemini' },
      }),
    );
  });

  it('pedido que já traduzia não transcreve de novo quando a reescrita falha', async () => {
    const { ports: p } = ports();
    const out = await finalizeCodeDictation(
      { ...literalRequest, translate: true },
      { ...literalResult, text: 'Commit and open the pull request.' },
      900,
      p,
    );
    expect(p.transcribe).not.toHaveBeenCalled();
    expect(out).toMatchObject({ ok: true, text: 'Commit and open the pull request.' });
  });

  it('tradução de socorro falhou: segue com o texto da STT, sem perder o ditado', async () => {
    const { ports: p } = ports({
      transcribe: vi.fn(async () => ({ ok: false, needsKey: false, error: 'down', attempts: [] }) as TranscribeResult),
    });
    const out = await finalizeCodeDictation(literalRequest, literalResult, 900, p);
    expect(out).toMatchObject({ ok: true, text: literalResult.text });
  });
});
