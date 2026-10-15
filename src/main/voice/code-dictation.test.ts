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
      'transcrição bruta concluída',
      expect.objectContaining({ polished: true, sttMs: 900, mode: 'code', chars: literalResult.text.length }),
    );
    expect(JSON.stringify(log.mock.calls)).not.toContain(literalResult.text);
  });

  it('F-1392: devolve tamanhos e resultado da reescrita para o log de uso (sem texto extra)', async () => {
    const ok = ports({
      polish: vi.fn(async () => ({ text: 'Commit and open the pull request.', polished: true })),
    });
    expect(await finalizeCodeDictation(literalRequest, literalResult, 900, ok.ports)).toMatchObject({
      polish: { ok: true, rawChars: literalResult.text.length },
    });
    const failed = ports({
      polish: vi.fn(async (text: string) => ({ text, polished: false, reason: 'unparseable' })),
    });
    expect(await finalizeCodeDictation(literalRequest, literalResult, 900, failed.ports)).toMatchObject({
      polish: { ok: false, rawChars: literalResult.text.length, reason: 'unparseable' },
    });
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
    // O caminho de falha também fica rastreável no voice.log com metadados.
    expect(log).toHaveBeenCalledWith(
      'info',
      'stt.dictationRaw',
      'transcrição bruta concluída',
      expect.objectContaining({
        polished: false,
        chars: literalResult.text.length,
        finalChars: 'Commit and open the pull request.'.length,
        translateFallback: { ok: true, provider: 'gemini' },
      }),
    );
    expect(JSON.stringify(log.mock.calls)).not.toContain(literalResult.text);
    expect(JSON.stringify(log.mock.calls)).not.toContain('Commit and open the pull request.');
  });

  it('F-1530: reescrita falhou com request que já pedia translate — tenta a STT de novo (provider anterior pode ser transcription-only)', async () => {
    const { ports: p } = ports();
    const out = await finalizeCodeDictation(
      { ...literalRequest, translate: true },
      { ...literalResult, text: 'Commit and open the pull request.' },
      900,
      p,
    );
    // F-1530: mesmo com translate:true, a STT de socorro roda —
    // o provider que atendeu a primeira transcrição pode ser
    // transcription-only (xAI Grok) e não traduziu de fato.
    expect(p.transcribe).toHaveBeenCalledOnce();
    expect(p.transcribe).toHaveBeenCalledWith(
      expect.objectContaining({ translate: true, prompt: DICTATION_CODE_PRIMING_PROMPT }),
    );
    // A segunda STT devolveu inglês e substituiu a entrega.
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
