import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { findSyntheticSources } from '../video/video-export';
import { encodeWav } from './wav-pcm';
import { forcedAlignmentCostUsd } from './voiceover-align';
import { generateGeminiVoiceover, geminiChunks, type GeminiVoiceoverDeps } from './voiceover-gemini';
import { geminiTtsCostUsd, PT_CHARS_PER_SECOND } from './voice-providers/gemini-voice';

/** F-1601 — narração com voz do Gemini, cronometrada pelo alinhamento (F-1602). */

let root: string;
let userData: string;
const scope = { projectId: 'p', checkoutId: 'c', rootRealPath: '' } as never;
const SCRIPT = 'O Claude escreve.\n\nBaixe hoje.';
const NOW = new Date('2026-10-20T12:00:00Z');

function ttsWav(seconds: number): string {
  return encodeWav({ sampleRate: 24_000, samples: new Int16Array(24_000 * seconds).fill(500) }).toString('base64');
}

const RECOGNIZED = [
  ['O', 0, 0.2],
  ['Claude', 0.2, 0.7],
  ['escreve.', 0.7, 1.4],
  ['Baixe', 2.3, 2.9],
  ['hoje.', 2.9, 3.6],
] as const;

function fetchStub() {
  return vi.fn(async (url: string | URL) => {
    const target = String(url);
    if (target.endsWith('/v1beta/interactions')) {
      return new Response(JSON.stringify({ steps: [{ content: [{ type: 'audio', data: ttsWav(2) }] }] }), { status: 200 });
    }
    if (target.endsWith('/v1/forced-alignment')) {
      return new Response(
        JSON.stringify({ words: RECOGNIZED.map(([text, start, end]) => ({ text, start, end, loss: 0.1 })), loss: 0.1 }),
        { status: 200 },
      );
    }
    return new Response('{}', { status: 404 });
  });
}

function deps(overrides: Partial<GeminiVoiceoverDeps> = {}): GeminiVoiceoverDeps {
  return {
    fetchFn: fetchStub() as unknown as typeof fetch,
    getKey: (def) => (def.id === 'google-image' ? 'gm-key' : def.id === 'elevenlabs' ? 'xi-key' : undefined),
    userData,
    manifestDir: path.join(root, 'manifest'),
    pathValue: '/bin',
    baseEnv: {},
    lookup: () => null,
    acquirePermit: async () => ({ release: () => undefined }) as never,
    isHardened: () => false,
    cacheDir: path.join(userData, 'media', 'voiceover-cache'),
    now: () => NOW,
    isNexusClone: (id) => id === 'voice_minha',
    ...overrides,
  };
}

function calls(d: GeminiVoiceoverDeps, suffix: string): Array<[string, RequestInit]> {
  return (d.fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls.filter(([url]) => String(url).endsWith(suffix)) as Array<
    [string, RequestInit]
  >;
}

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-gemini-vo-')));
  userData = path.join(root, 'ud');
  (scope as { rootRealPath: string }).rootRealPath = root;
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('narração com voz do Gemini', () => {
  it('dá o preço antes sem chamar nada: síntese do Gemini + alinhamento da ElevenLabs', async () => {
    const d = deps();
    const priced = await generateGeminiVoiceover({ script: SCRIPT, voice: 'Kore', baseDir: root, scope, dryRun: true }, d);
    const chars = 'O Claude escreve.'.length + 'Baixe hoje.'.length;
    const seconds = chars / PT_CHARS_PER_SECOND;
    expect(priced).toMatchObject({
      ok: true,
      dryRun: true,
      provider: 'gemini',
      voiceId: 'Kore',
      voice: { name: 'Kore', origin: 'library' },
      chunks: 2,
      cachedChunks: 0,
      alignEngine: 'elevenlabs',
      estimatedCostUsd: Number((geminiTtsCostUsd(seconds, NOW) + forcedAlignmentCostUsd(seconds)).toFixed(4)),
    });
    expect(d.fetchFn).not.toHaveBeenCalled();
  });

  it('sintetiza por parágrafo, junta num WAV, alinha e marca como sintética; repetir o roteiro usa o cache', async () => {
    const d = deps();
    const result = await generateGeminiVoiceover(
      { script: SCRIPT, voice: 'voice_minha', style: 'calmo', outDir: 'promo', baseDir: root, scope },
      d,
    );
    if (!result.ok) throw new Error(result.error);
    const tts = calls(d, '/v1beta/interactions');
    expect(tts).toHaveLength(2);
    expect(tts[0][1].headers).toMatchObject({ 'x-goog-api-key': 'gm-key' });
    const body = JSON.parse(String(tts[0][1].body)) as {
      model: string;
      generation_config: { speech_config: Array<{ voice: string }> };
      input: Array<{ content: Array<{ text: string; annotations?: unknown }> }>;
    };
    expect(body.model).toBe('gemini-3.8-flash-tts');
    expect(body.generation_config.speech_config[0].voice).toBe('voice_minha');
    expect(body.input[0].content[0]).toMatchObject({ text: 'O Claude escreve.', annotations: [{ style: 'calmo' }] });
    expect(calls(d, '/v1/forced-alignment')).toHaveLength(1);
    expect(result).toMatchObject({ voice: { name: null, origin: 'nexus-clone' }, alignEngine: 'elevenlabs', matchedRatio: 1 });
    expect(result.durationMs).toBe(4250);
    expect(result.estimatedCostUsd).toBe(Number((geminiTtsCostUsd(4, NOW) + forcedAlignmentCostUsd(4.25)).toFixed(4)));

    const timeline = JSON.parse(fs.readFileSync(result.files!.timeline, 'utf8')) as {
      generator: string;
      provider: string;
      synthetic?: { label: string };
      alignment: { engine: string };
    };
    expect(timeline).toMatchObject({ generator: 'nexus_voiceover_generate', provider: 'gemini', alignment: { engine: 'elevenlabs' } });
    expect(timeline.synthetic?.label).toBeTruthy();
    expect(findSyntheticSources(path.join(root, 'promo')).narration).toHaveLength(1);

    const again = deps();
    const priced = await generateGeminiVoiceover({ script: SCRIPT, voice: 'voice_minha', style: 'calmo', baseDir: root, scope, dryRun: true }, again);
    expect(priced).toMatchObject({ ok: true, cachedChunks: 2 });
    const rerun = await generateGeminiVoiceover({ script: SCRIPT, voice: 'voice_minha', style: 'calmo', outDir: 'promo', baseDir: root, scope }, again);
    expect(rerun.ok).toBe(true);
    expect(calls(again, '/v1beta/interactions')).toHaveLength(0);
  });

  it('recusa voz desconhecida, falta de chave e o download do modelo local sem o OK', async () => {
    expect(await generateGeminiVoiceover({ script: SCRIPT, voice: 'Rachel', baseDir: root, scope }, deps())).toMatchObject({
      ok: false,
      error: expect.stringMatching(/voz do Gemini desconhecida/u),
    });
    expect(
      await generateGeminiVoiceover({ script: SCRIPT, voice: 'Kore', baseDir: root, scope }, deps({ getKey: (def) => (def.id === 'elevenlabs' ? 'xi' : undefined) })),
    ).toMatchObject({ ok: false, error: expect.stringMatching(/Gemini sem chave/u) });
    const local = deps({ getKey: (def) => (def.id === 'google-image' ? 'gm-key' : undefined) });
    expect(await generateGeminiVoiceover({ script: SCRIPT, voice: 'Kore', baseDir: root, scope, dryRun: true }, local)).toMatchObject({
      ok: true,
      alignEngine: 'local',
      needsModelDownload: true,
    });
    expect(await generateGeminiVoiceover({ script: SCRIPT, voice: 'Kore', baseDir: root, scope }, local)).toMatchObject({
      ok: false,
      needsModelDownload: true,
    });
    expect(local.fetchFn).not.toHaveBeenCalled();
    expect(await generateGeminiVoiceover({ script: '   ', voice: 'Kore', baseDir: root, scope }, deps())).toMatchObject({
      ok: false,
      error: 'roteiro vazio',
    });
  });

  it('divide parágrafo longo em frases sem passar do limite do modelo', () => {
    const sentence = 'Uma frase de teste com algumas palavras. ';
    const chunks = geminiChunks([sentence.repeat(10).trim(), 'Curto.'], 100);
    expect(chunks.every((chunk) => chunk.length <= 100)).toBe(true);
    expect(chunks.at(-1)).toBe('Curto.');
    expect(chunks.join(' ').replace(/\s+/gu, ' ')).toBe(`${sentence.repeat(10).trim()} Curto.`);
  });
});
