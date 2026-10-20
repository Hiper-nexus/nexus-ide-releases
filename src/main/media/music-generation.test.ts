import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateMusic, musicCostUsd, type MusicDeps } from './music-generation';

let workspace: string;

beforeEach(() => {
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-music-'));
});

afterEach(() => {
  fs.rmSync(workspace, { recursive: true, force: true });
});

function deps(fetchFn: (input: string | URL, init?: RequestInit) => Promise<Response>): MusicDeps {
  return { fetchFn: fetchFn as unknown as typeof fetch, getKey: () => 'xi-key', now: () => 1_700_000_000_000 };
}

describe('generateMusic', () => {
  it('custo de lista: US$ 0,15 por minuto', () => {
    expect(musicCostUsd(60_000)).toBe(0.15);
    expect(musicCostUsd(45_000)).toBe(0.1125);
  });

  it('dryRun mostra custo e licença sem rede', async () => {
    const fetchFn = vi.fn();
    const result = await generateMusic({ prompt: 'piano calmo', lengthMs: 30_000, dryRun: true, baseDir: workspace }, deps(fetchFn));
    expect(fetchFn).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      ok: true,
      dryRun: true,
      model: 'music_v2_5',
      instrumental: true,
      estimatedCostUsd: 0.075,
      license: expect.stringMatching(/music-terms/u),
    });
  });

  it('pede instrumental, assinatura C2PA e grava mp3 + proveniência', async () => {
    let sent: Record<string, unknown> = {};
    let url = '';
    const fetchFn = vi.fn(async (input: string | URL, init?: RequestInit) => {
      url = String(input);
      sent = JSON.parse(String(init?.body));
      expect(((init?.headers ?? {}) as Record<string, string>)['xi-api-key']).toBe('xi-key');
      return new Response(Buffer.from('ID3fake-mp3'), { status: 200, headers: { 'song-id': 'song_123' } });
    });
    const result = await generateMusic(
      { prompt: 'synthwave suave', lengthMs: 45_000, outPath: 'promo/assets/music.mp3', baseDir: workspace },
      deps(fetchFn),
    );
    expect(url).toBe('https://api.elevenlabs.io/v1/music?output_format=mp3_44100_128');
    expect(sent).toEqual({
      prompt: 'synthwave suave',
      music_length_ms: 45_000,
      model_id: 'music_v2_5',
      force_instrumental: true,
      sign_with_c2pa: true,
    });
    expect(result).toMatchObject({ ok: true, dryRun: false, songId: 'song_123' });
    if (!result.ok) throw new Error('falhou');
    expect(fs.readFileSync(result.path!, 'utf8')).toBe('ID3fake-mp3');
    const provenance = JSON.parse(fs.readFileSync(result.provenancePath!, 'utf8'));
    expect(provenance).toMatchObject({
      generator: 'nexus_music_generate',
      kind: 'music',
      audio: 'music.mp3',
      c2paSignedByProvider: true,
      songId: 'song_123',
    });
  });

  it('instrumental: false manda force_instrumental false', async () => {
    let sent: Record<string, unknown> = {};
    const fetchFn = vi.fn(async (_input: string | URL, init?: RequestInit) => {
      sent = JSON.parse(String(init?.body));
      return new Response(Buffer.from('x'), { status: 200 });
    });
    await generateMusic({ prompt: 'jingle', lengthMs: 10_000, instrumental: false, baseDir: workspace }, deps(fetchFn));
    expect(sent.force_instrumental).toBe(false);
  });

  it('prompt com artista devolve a sugestão da ElevenLabs sem gravar nada', async () => {
    const fetchFn = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            detail: { status: 'bad_prompt', data: { prompt_suggestion: 'upbeat 80s synth pop' } },
          }),
          { status: 400 },
        ),
    );
    const result = await generateMusic({ prompt: 'no estilo de um artista famoso', lengthMs: 10_000, baseDir: workspace }, deps(fetchFn));
    expect(result).toMatchObject({
      ok: false,
      error: expect.stringMatching(/cita artista/u),
      promptSuggestion: 'upbeat 80s synth pop',
    });
    expect(fs.readdirSync(workspace)).toEqual([]);
  });

  it('duração e modelo fora da faixa são recusados antes da rede', async () => {
    const fetchFn = vi.fn();
    await expect(generateMusic({ prompt: 'x', lengthMs: 1_000, baseDir: workspace }, deps(fetchFn))).rejects.toThrow(/lengthMs/u);
    await expect(
      generateMusic({ prompt: 'x', lengthMs: 10_000, model: 'music_v9', baseDir: workspace }, deps(fetchFn)),
    ).rejects.toThrow(/não habilitado/u);
    await expect(
      generateMusic({ prompt: 'x', lengthMs: 10_000, outPath: '../fora.mp3', baseDir: workspace }, deps(fetchFn)),
    ).rejects.toThrow(/escapa o workspace/u);
    await expect(
      generateMusic({ prompt: 'x', lengthMs: 10_000, outPath: 'trilha.wav', baseDir: workspace }, deps(fetchFn)),
    ).rejects.toThrow(/\.mp3/u);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('sem chave não chama o provedor', async () => {
    const fetchFn = vi.fn();
    await expect(
      generateMusic({ prompt: 'x', lengthMs: 10_000, baseDir: workspace }, { ...deps(fetchFn), getKey: () => undefined }),
    ).rejects.toThrow(/Serviços de mídia/u);
    expect(fetchFn).not.toHaveBeenCalled();
  });
});
