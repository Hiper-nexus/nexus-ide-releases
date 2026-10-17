import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./stt-service', () => ({ transcribe: vi.fn() }));
vi.mock('./voice-config-store', () => ({
  getVoiceConfig: vi.fn(() => ({ stt: {} })),
  currentProbes: vi.fn(() => ({})),
}));

import { transcribe } from './stt-service';
import { currentProbes, getVoiceConfig } from './voice-config-store';
import {
  MISSION_TRANSCRIPT_MAX_BYTES,
  runMissionAttachmentTranscript,
  scheduleMissionAttachmentTranscript,
} from './mission-attachment-transcript';

const transcribeMock = vi.mocked(transcribe);

let dir = '';

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nx-att-tr-'));
  transcribeMock.mockReset();
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function audio(name: string, bytes = 'audio-bytes'): string {
  const file = path.join(dir, name);
  fs.writeFileSync(file, bytes);
  return file;
}

function sidecar(file: string): string {
  return `${file}.transcript.txt`;
}

describe('runMissionAttachmentTranscript', () => {
  it('grava o sidecar ao lado do áudio com a cadeia STT configurada, literal', async () => {
    transcribeMock.mockResolvedValue({
      ok: true,
      text: '  oi, refaça o botão  ',
      provider: 'gemini',
      attempts: [],
    });
    const file = audio('nota.mp3');

    await expect(runMissionAttachmentTranscript(file)).resolves.toBe(true);

    expect(fs.readFileSync(sidecar(file), 'utf8')).toBe('oi, refaça o botão');
    const [request] = transcribeMock.mock.calls[0]!;
    expect(request.mime).toBe('audio/mpeg');
    // Missão não quer PT→EN: a cadeia Whisper padrão traduziria para o ditado.
    expect(request.translate).toBe(false);
    expect(request.purpose).toBeUndefined();
    expect(getVoiceConfig).toHaveBeenCalled();
    expect(currentProbes).toHaveBeenCalled();
  });

  it('falha silenciosa: STT sem sucesso não cria sidecar nem lança', async () => {
    transcribeMock.mockResolvedValue({
      ok: false,
      needsKey: true,
      attempts: [{ provider: 'groq', reason: 'GROQ_API_KEY not set' }],
      error: 'no provider',
    });
    const file = audio('nota.wav');

    await expect(runMissionAttachmentTranscript(file)).resolves.toBe(false);

    expect(fs.existsSync(sidecar(file))).toBe(false);
  });

  it('transcrição de ruído (whisper em silêncio) não vira sidecar', async () => {
    transcribeMock.mockResolvedValue({
      ok: true,
      text: 'Obrigado por assistir',
      provider: 'groq',
      attempts: [],
    });
    const file = audio('vazia.opus');

    await expect(runMissionAttachmentTranscript(file)).resolves.toBe(false);

    expect(fs.existsSync(sidecar(file))).toBe(false);
  });

  it('recusa áudio acima do teto de tamanho sem chamar a STT', async () => {
    const file = audio('enorme.mp3', 'x');
    fs.truncateSync(file, MISSION_TRANSCRIPT_MAX_BYTES + 1);

    await expect(runMissionAttachmentTranscript(file)).resolves.toBe(false);

    expect(transcribeMock).not.toHaveBeenCalled();
    expect(fs.existsSync(sidecar(file))).toBe(false);
  });

  it('timeout do job abandona sem sidecar e sem lançar', async () => {
    transcribeMock.mockImplementation(() => new Promise(() => {}));
    const file = audio('lenta.flac');

    await expect(
      runMissionAttachmentTranscript(file, { timeoutMs: 25 }),
    ).resolves.toBe(false);

    expect(fs.existsSync(sidecar(file))).toBe(false);
  });

  it('sidecar já existente não retranscreve', async () => {
    const file = audio('feita.m4a');
    fs.writeFileSync(sidecar(file), 'já transcrita');

    await expect(runMissionAttachmentTranscript(file)).resolves.toBe(false);

    expect(transcribeMock).not.toHaveBeenCalled();
  });

  it('extensão que não é áudio e arquivo vazio passam em branco', async () => {
    const png = audio('print.png');
    const empty = audio('zero.ogg', '');

    await expect(runMissionAttachmentTranscript(png)).resolves.toBe(false);
    await expect(runMissionAttachmentTranscript(empty)).resolves.toBe(false);

    expect(transcribeMock).not.toHaveBeenCalled();
  });
});

describe('scheduleMissionAttachmentTranscript', () => {
  it('dispara sem bloquear e o sidecar aparece depois', async () => {
    transcribeMock.mockResolvedValue({
      ok: true,
      text: 'bom dia, equipe',
      provider: 'gemini',
      attempts: [],
    });
    const file = audio('nota.m4a');

    scheduleMissionAttachmentTranscript(file);
    // O chamador não espera: só garantimos que o job roda até o fim.
    await vi.waitFor(() => expect(fs.existsSync(sidecar(file))).toBe(true));
    expect(fs.readFileSync(sidecar(file), 'utf8')).toBe('bom dia, equipe');
  });

  it('segunda chamada para o mesmo caminho durante o job não duplica a STT', async () => {
    transcribeMock.mockResolvedValue({
      ok: true,
      text: 'oi',
      provider: 'gemini',
      attempts: [],
    });
    const file = audio('unica.mp3');

    scheduleMissionAttachmentTranscript(file);
    scheduleMissionAttachmentTranscript(file);

    await vi.waitFor(() => expect(fs.existsSync(sidecar(file))).toBe(true));
    expect(transcribeMock).toHaveBeenCalledTimes(1);
  });
});
