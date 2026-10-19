import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  generateVoiceover,
  planVoiceoverChunks,
  purgeVoiceoverCacheForVoice,
  splitLongParagraph,
  voiceoverChunkKey,
  type VoiceoverDeps,
} from './voiceover';

/** MPEG-1 Layer III 128 kbps 44.1 kHz frames: 417 bytes, 26.12 ms each. */
function mp3(frames: number): Buffer {
  const one = Buffer.alloc(417, 0x11);
  one[0] = 0xff;
  one[1] = 0xfb;
  one[2] = 0x90;
  one[3] = 0x00;
  return Buffer.concat(Array.from({ length: frames }, () => one));
}

function alignment(text: string) {
  const characters = [...text];
  return {
    characters,
    character_start_times_seconds: characters.map((_, index) => index * 0.05),
    character_end_times_seconds: characters.map((_, index) => (index + 1) * 0.05),
  };
}

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: Record<string, unknown> | null;
}

function fakeFetch(options: { framesPerChunk?: number; alignmentNull?: boolean } = {}) {
  const calls: Call[] = [];
  const fn = vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : null;
    calls.push({
      url,
      method: init?.method ?? 'GET',
      headers: (init?.headers ?? {}) as Record<string, string>,
      body,
    });
    if (url.includes('/with-timestamps')) {
      const text = String(body?.text ?? '');
      return new Response(
        JSON.stringify({
          audio_base64: mp3(options.framesPerChunk ?? 40).toString('base64'),
          alignment: options.alignmentNull ? null : alignment(text),
        }),
        { status: 200 },
      );
    }
    if (url.includes('/v1/voices/')) {
      return new Response(
        JSON.stringify({ voice_id: 'voz1', name: 'Minha voz', category: 'cloned', is_owner: true }),
        { status: 200 },
      );
    }
    return new Response('not found', { status: 404 });
  });
  return { fn, calls };
}

let workspace: string;
let cacheDir: string;

function deps(fetchFn: typeof fetch, overrides: Partial<VoiceoverDeps> = {}): VoiceoverDeps {
  return {
    fetchFn,
    getKey: () => 'xi-test-key',
    cacheDir,
    isNexusClone: (id) => id === 'voz1',
    ...overrides,
  };
}

beforeEach(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-vo-ws-'));
  cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-vo-cache-'));
});

afterEach(() => {
  fs.rmSync(workspace, { recursive: true, force: true });
  fs.rmSync(cacheDir, { recursive: true, force: true });
});

const SCRIPT = 'O Claude abre panes. O Gemini revisa.\n\nTudo no Nexus IDE.';

describe('planejamento dos trechos', () => {
  it('um trecho por parágrafo', () => {
    expect(planVoiceoverChunks(SCRIPT).chunks).toEqual([
      'O Claude abre panes. O Gemini revisa.',
      'Tudo no Nexus IDE.',
    ]);
  });

  it('parágrafo longo quebra por frase, e frase longa por palavra', () => {
    const sentence = 'Palavra '.repeat(20).trim() + '.';
    const pieces = splitLongParagraph(`${sentence} ${sentence}`, 200);
    expect(pieces).toHaveLength(2);
    expect(pieces.every((piece) => piece.length <= 200)).toBe(true);
    const words = splitLongParagraph('abcdefghij '.repeat(30).trim(), 50);
    expect(words.every((piece) => piece.length <= 50)).toBe(true);
    expect(words.join(' ')).toBe('abcdefghij '.repeat(30).trim());
  });
});

describe('generateVoiceover', () => {
  it('dryRun dá caracteres e custo sem tocar na rede', async () => {
    const { fn } = fakeFetch();
    const result = await generateVoiceover(
      { script: SCRIPT, dryRun: true, baseDir: workspace },
      deps(fn as unknown as typeof fetch),
    );
    expect(fn).not.toHaveBeenCalled();
    expect(result).toMatchObject({ ok: true, dryRun: true, chunks: 2, cachedChunks: 0 });
    expect(result.chars).toBe(SCRIPT.replace('\n\n', '').length);
    expect(result.estimatedCostUsd).toBeGreaterThan(0);
    expect(fs.readdirSync(workspace)).toEqual([]);
  });

  it('grava mp3, linha do tempo, SRT e VTT com a grafia do roteiro', async () => {
    const { fn, calls } = fakeFetch();
    const result = await generateVoiceover(
      { script: SCRIPT, voiceId: 'voz1', outDir: 'promo/assets', baseDir: workspace },
      deps(fn as unknown as typeof fetch),
    );
    expect(result.files).toBeDefined();
    const files = result.files!;
    for (const file of Object.values(files)) {
      expect(fs.existsSync(file)).toBe(true);
      expect(path.dirname(file)).toBe(path.join(fs.realpathSync(workspace), 'promo', 'assets'));
    }
    const tts = calls.filter((call) => call.url.includes('/with-timestamps'));
    expect(tts).toHaveLength(2);
    expect(tts[0].url).toContain('/v1/text-to-speech/voz1/with-timestamps?output_format=mp3_44100_128');
    expect(tts[0].headers['xi-api-key']).toBe('xi-test-key');
    expect(tts[0].body).toMatchObject({
      text: 'O Claude abre panes. O Gemini revisa.',
      model_id: 'eleven_multilingual_v2',
      next_text: 'Tudo no Nexus IDE.',
    });
    expect(tts[1].body).toMatchObject({ previous_text: 'O Claude abre panes. O Gemini revisa.' });

    const timeline = JSON.parse(fs.readFileSync(files.timeline, 'utf8'));
    expect(timeline).toMatchObject({
      version: 1,
      generator: 'nexus_voiceover_generate',
      audio: 'narration.mp3',
      captions: { srt: 'narration.srt', vtt: 'narration.vtt' },
      voice: { id: 'voz1', name: 'Minha voz', origin: 'nexus-clone' },
      synthetic: { label: 'Narração com voz gerada por IA' },
    });
    expect(timeline.words.map((word: { text: string }) => word.text).join(' ')).toBe(
      'O Claude abre panes. O Gemini revisa. Tudo no Nexus IDE.',
    );
    // O 2º trecho começa depois de 40 quadros do 1º (40 × 1152 / 44100 s).
    const firstOfSecond = timeline.words.find((word: { text: string }) => word.text === 'Tudo');
    expect(firstOfSecond.startMs).toBe(Math.round((40 * 1152 * 1000) / 44_100));
    expect(timeline.durationMs).toBe(Math.round((80 * 1152 * 1000) / 44_100));
    expect(timeline.paragraphs).toHaveLength(2);
    expect(fs.readFileSync(files.srt, 'utf8')).toMatch(/^1\n00:00:00,000 --> /u);
    expect(fs.readFileSync(files.vtt, 'utf8')).toMatch(/^WEBVTT\n/u);
    expect(fs.statSync(files.audio).size).toBe(80 * 417);
    expect(result).toMatchObject({ chunks: 2, cachedChunks: 0, words: 11 });
  });

  it('pedir a mesma narração de novo não paga de novo', async () => {
    const first = fakeFetch();
    await generateVoiceover({ script: SCRIPT, voiceId: 'voz1', baseDir: workspace }, deps(first.fn as unknown as typeof fetch));
    const second = fakeFetch();
    const dry = await generateVoiceover(
      { script: SCRIPT, voiceId: 'voz1', dryRun: true, baseDir: workspace },
      deps(second.fn as unknown as typeof fetch),
    );
    expect(dry).toMatchObject({ cachedChunks: 2, estimatedCostUsd: 0 });
    const again = await generateVoiceover(
      { script: SCRIPT, voiceId: 'voz1', baseDir: workspace },
      deps(second.fn as unknown as typeof fetch),
    );
    expect(second.calls.filter((call) => call.url.includes('/with-timestamps'))).toHaveLength(0);
    expect(again).toMatchObject({ cachedChunks: 2, estimatedCostUsd: 0 });
  });

  it('editar um parágrafo paga só esse parágrafo', async () => {
    const first = fakeFetch();
    await generateVoiceover({ script: SCRIPT, voiceId: 'voz1', baseDir: workspace }, deps(first.fn as unknown as typeof fetch));
    const second = fakeFetch();
    await generateVoiceover(
      { script: SCRIPT.replace('Tudo no Nexus IDE.', 'Tudo num lugar só.'), voiceId: 'voz1', baseDir: workspace },
      deps(second.fn as unknown as typeof fetch),
    );
    const tts = second.calls.filter((call) => call.url.includes('/with-timestamps'));
    expect(tts.map((call) => call.body?.text)).toEqual(['Tudo num lugar só.']);
  });

  it('outra voz, modelo ou ajuste é outra chave de cache', () => {
    const base = { text: 'oi', voiceId: 'a', model: 'eleven_multilingual_v2' };
    const key = voiceoverChunkKey(base);
    expect(voiceoverChunkKey({ ...base, voiceId: 'b' })).not.toBe(key);
    expect(voiceoverChunkKey({ ...base, model: 'eleven_turbo_v2_5' })).not.toBe(key);
    expect(voiceoverChunkKey({ ...base, settings: { speed: 1.1 } })).not.toBe(key);
    expect(voiceoverChunkKey({ ...base })).toBe(key);
  });

  it('modelo sem tempo por caractere vira erro com a saída', async () => {
    const { fn } = fakeFetch({ alignmentNull: true });
    await expect(
      generateVoiceover({ script: SCRIPT, voiceId: 'voz1', baseDir: workspace }, deps(fn as unknown as typeof fetch)),
    ).rejects.toThrow(/eleven_multilingual_v2/u);
    expect(fs.readdirSync(workspace)).toEqual([]);
  });

  it('sem voiceId não paga nada', async () => {
    const { fn } = fakeFetch();
    await expect(
      generateVoiceover({ script: SCRIPT, baseDir: workspace }, deps(fn as unknown as typeof fetch)),
    ).rejects.toThrow(/nexus_voice_list/u);
    expect(fn).not.toHaveBeenCalled();
  });

  it('saída fora do workspace é recusada antes da rede', async () => {
    const { fn } = fakeFetch();
    await expect(
      generateVoiceover(
        { script: SCRIPT, voiceId: 'voz1', outDir: '../fora', baseDir: workspace },
        deps(fn as unknown as typeof fetch),
      ),
    ).rejects.toThrow(/escapa o workspace/u);
    expect(fn).not.toHaveBeenCalled();
  });

  it('modelo fora da lista é recusado', async () => {
    const { fn } = fakeFetch();
    await expect(
      generateVoiceover(
        { script: SCRIPT, voiceId: 'voz1', model: 'eleven_inventado', baseDir: workspace },
        deps(fn as unknown as typeof fetch),
      ),
    ).rejects.toThrow(/não habilitado/u);
  });

  it('chave recusada diz onde configurar, sem ecoar a chave', async () => {
    const fn = vi.fn(async () => new Response(JSON.stringify({ detail: { message: 'invalid api key' } }), { status: 401 }));
    const error = await generateVoiceover(
      { script: SCRIPT, voiceId: 'voz1', baseDir: workspace },
      deps(fn as unknown as typeof fetch),
    ).catch((err: Error) => err);
    expect(String(error)).toMatch(/Serviços de mídia/u);
    expect(String(error)).not.toContain('xi-test-key');
  });

  it('cancelado antes de começar não chama o provedor', async () => {
    const { fn } = fakeFetch();
    const controller = new AbortController();
    controller.abort();
    await expect(
      generateVoiceover(
        { script: SCRIPT, voiceId: 'voz1', baseDir: workspace, signal: controller.signal },
        deps(fn as unknown as typeof fetch),
      ),
    ).rejects.toThrow(/cancelada/u);
    expect(fn).not.toHaveBeenCalled();
  });

  it('apagar a voz limpa o cache dela e só dela', async () => {
    const { fn } = fakeFetch();
    await generateVoiceover({ script: SCRIPT, voiceId: 'voz1', baseDir: workspace }, deps(fn as unknown as typeof fetch));
    await generateVoiceover({ script: 'Outra voz.', voiceId: 'voz2', baseDir: workspace }, deps(fn as unknown as typeof fetch));
    expect(purgeVoiceoverCacheForVoice(cacheDir, 'voz1')).toBe(2);
    const left = fs.readdirSync(cacheDir).filter((name) => name.endsWith('.json'));
    expect(left).toHaveLength(1);
    expect(JSON.parse(fs.readFileSync(path.join(cacheDir, left[0]), 'utf8')).voiceId).toBe('voz2');
  });

  it('cache gravado é privado (0600) fora do Windows', async () => {
    const { fn } = fakeFetch();
    await generateVoiceover({ script: 'Oi.', voiceId: 'voz1', baseDir: workspace }, deps(fn as unknown as typeof fetch));
    if (process.platform === 'win32') return;
    for (const name of fs.readdirSync(cacheDir)) {
      expect(fs.statSync(path.join(cacheDir, name)).mode & 0o777).toBe(0o600);
    }
  });
});
