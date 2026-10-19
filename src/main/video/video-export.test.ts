import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { OwnedProcessOptions, OwnedProcessResult } from './video-process';
import { decideLabel, exportVideo, findSyntheticSources, type ExportDeps } from './video-export';
import type { MediaProbe } from './ffprobe';

let workspace: string;
let project: string;

function probe(width: number, height: number, audio = true): MediaProbe {
  return {
    durationSec: 30,
    sizeBytes: 1,
    formatName: 'mp4',
    video: { codec: 'h264', width, height, fps: 30, pixFmt: 'yuv420p', profile: 'High' },
    audio: audio ? { codec: 'aac', sampleRate: 48_000, channels: 2 } : null,
    tags: {},
  };
}

const LOUDNORM_JSON = '{\n"input_i" : "-20.0",\n"input_tp" : "-3.0",\n"input_lra" : "5.0",\n"input_thresh" : "-30.0",\n"target_offset" : "0.1"\n}';

function fakeFfmpeg(calls: OwnedProcessOptions[]): (options: OwnedProcessOptions) => Promise<OwnedProcessResult> {
  return async (options) => {
    calls.push(options);
    const args = options.args;
    const result = (tail: string[]): OwnedProcessResult => ({ exitCode: 0, timedOut: false, aborted: false, tail });
    if (args.includes('null') && args.some((arg) => arg.startsWith('loudnorm'))) return result(LOUDNORM_JSON.split('\n'));
    if (args.includes('null') && args.includes('ebur128=peak=true')) {
      return result(['Summary:', '  Integrated loudness:', '    I:         -14.2 LUFS', '  True peak:', '    Peak:       -1.1 dBFS']);
    }
    fs.writeFileSync(args[args.length - 1], 'out');
    return result([]);
  };
}

function deps(calls: OwnedProcessOptions[], overrides: Partial<ExportDeps> = {}): ExportDeps {
  const font = path.join(workspace, 'fonts', 'Label.ttf');
  fs.mkdirSync(path.dirname(font), { recursive: true });
  fs.writeFileSync(font, 'ttf');
  return {
    pathValue: '/bin',
    baseEnv: { PATH: '/bin', OPENAI_API_KEY: 'sk-secret' },
    lookup: (command) => `/bin/${command}`,
    acquirePermit: async () => ({ id: 'p', release: () => undefined }),
    home: path.join(workspace, '.engine-home'),
    run: fakeFfmpeg(calls),
    probe: async () => probe(1080, 1920),
    fontCandidates: [path.join(workspace, 'nao-existe.ttf'), font],
    ...overrides,
  };
}

function writeNarration(origin: string) {
  const assets = path.join(project, 'assets');
  fs.mkdirSync(assets, { recursive: true });
  fs.writeFileSync(
    path.join(assets, 'narration.timeline.json'),
    JSON.stringify({ generator: 'nexus_voiceover_generate', provider: 'elevenlabs', model: 'eleven_v4', voice: { id: 'v', origin }, captions: { srt: 'narration.srt', vtt: 'narration.vtt' } }),
  );
  fs.writeFileSync(path.join(assets, 'narration.srt'), '1\n00:00:00,000 --> 00:00:01,000\nOlá\n');
  fs.writeFileSync(path.join(assets, 'narration.vtt'), 'WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nOlá\n');
}

beforeEach(() => {
  workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-export-')));
  project = path.join(workspace, 'promo');
  fs.mkdirSync(path.join(project, 'renders'), { recursive: true });
  fs.writeFileSync(path.join(project, 'hyperframes.json'), '{}');
  fs.writeFileSync(path.join(project, 'renders', 'v1.mp4'), 'mp4');
});

afterEach(() => {
  fs.rmSync(workspace, { recursive: true, force: true });
});

describe('fontes sintéticas e rótulo', () => {
  it('acha a narração e a música que o Nexus gerou, fora de renders/exports', () => {
    writeNarration('nexus-clone');
    fs.writeFileSync(path.join(project, 'assets', 'music.provenance.json'), JSON.stringify({ generator: 'nexus_music_generate', provider: 'elevenlabs', model: 'music_v2_5' }));
    fs.mkdirSync(path.join(project, 'exports'));
    fs.writeFileSync(path.join(project, 'exports', 'x.timeline.json'), JSON.stringify({ generator: 'nexus_voiceover_generate' }));
    const sources = findSyntheticSources(project);
    expect(sources.narration).toHaveLength(1);
    expect(sources.music).toHaveLength(1);
    expect(sources.captions?.srt).toBe(path.join(project, 'assets', 'narration.srt'));
  });

  it('auto queima o rótulo para voz clonada ou desconhecida, não para voz de biblioteca', () => {
    const withVoice = (origin: string) => ({ narration: [{ file: 'f', provider: 'p', model: 'm', voiceOrigin: origin }], music: [], captions: null });
    expect(decideLabel('auto', withVoice('nexus-clone')).burned).toBe(true);
    expect(decideLabel('auto', withVoice('external-clone')).burned).toBe(true);
    expect(decideLabel('auto', withVoice('unknown')).burned).toBe(true);
    expect(decideLabel('auto', withVoice('library')).burned).toBe(false);
    expect(decideLabel('off', withVoice('nexus-clone')).burned).toBe(false);
    expect(decideLabel('on', { narration: [], music: [], captions: null }).burned).toBe(true);
  });
});

describe('exportVideo', () => {
  it('três passadas: mede, codifica com a medição e confere; versão muda, capa, legenda e proveniência', async () => {
    writeNarration('nexus-clone');
    const calls: OwnedProcessOptions[] = [];
    const result = await exportVideo(
      { input: 'promo/renders/v1.mp4', preset: 'vertical-9x16', baseDir: workspace, scope: {} as never },
      deps(calls),
    );
    expect(result).toMatchObject({
      ok: true,
      label: { burned: true },
      loudness: { integratedLufs: -14.2, truePeakDb: -1.1, withinTarget: true },
      digitalSourceType: 'http://cv.iptc.org/newscodes/digitalsourcetype/compositeWithTrainedAlgorithmicMedia',
      aspectMismatch: false,
    });
    if (!result.ok) throw new Error(result.error);
    const exportsDir = path.join(project, 'exports');
    expect(result.files.video).toBe(path.join(exportsDir, 'v1-vertical-9x16.mp4'));
    for (const file of [result.files.video, result.files.mute, result.files.cover, result.files.provenance, result.files.srt!, result.files.vtt!]) {
      expect(fs.existsSync(file)).toBe(true);
    }
    expect(fs.readdirSync(exportsDir).some((name) => name.includes('.part.'))).toBe(false);
    const encode = calls[1];
    expect(encode.args).toEqual(expect.arrayContaining(['-c:v', 'libx264', '-profile:v', 'high', '-pix_fmt', 'yuv420p', '-ar', '48000', '-movflags', '+faststart+use_metadata_tags']));
    expect(encode.args.join(' ')).toContain('measured_I=-20.0');
    expect(encode.args.join(' ')).toContain("drawtext=fontfile=Label.ttf");
    expect(encode.cwd).toBe(path.join(workspace, 'fonts'));
    expect(encode.args).toContain('digital_source_type=http://cv.iptc.org/newscodes/digitalsourcetype/compositeWithTrainedAlgorithmicMedia');
    expect(Object.values(encode.env).join(' ')).not.toContain('sk-secret');
    expect(calls.find((call) => call.args.includes('-an'))?.args).toEqual(expect.arrayContaining(['-c:v', 'copy']));
    const provenance = JSON.parse(fs.readFileSync(result.files.provenance, 'utf8'));
    expect(provenance).toMatchObject({ generator: 'nexus_video_export', source: '../renders/v1.mp4', visibleLabel: { text: 'Narração com voz gerada por IA', seconds: 6 } });
    expect(result.publishChecklist.map((item) => item.network)).toEqual(['instagram-reels', 'youtube-shorts', 'tiktok']);
  });

  it('sem voz sintética: sem rótulo nem metadado de IA; sem áudio pula o loudnorm', async () => {
    const calls: OwnedProcessOptions[] = [];
    const result = await exportVideo(
      { input: 'promo/renders/v1.mp4', preset: 'youtube-16x9', baseDir: workspace, scope: {} as never },
      deps(calls, { probe: async () => probe(1080, 1920, false) }),
    );
    expect(result).toMatchObject({ ok: true, label: { burned: false }, digitalSourceType: null, loudness: null, aspectMismatch: true });
    expect(calls.some((call) => call.args.some((arg) => arg.startsWith('loudnorm')))).toBe(false);
    expect(calls[0].args).toContain('-an');
  });

  it('entrada fora do workspace, preset inválido e falta de ffmpeg são recusados', async () => {
    const calls: OwnedProcessOptions[] = [];
    await expect(
      exportVideo({ input: '../fora.mp4', preset: 'vertical-9x16', baseDir: workspace, scope: {} as never }, deps(calls)),
    ).rejects.toThrow(/não existe|fora do workspace/u);
    expect(
      await exportVideo({ input: 'promo/renders/v1.mp4', preset: 'cinema' as never, baseDir: workspace, scope: {} as never }, deps(calls)),
    ).toMatchObject({ ok: false });
    expect(
      await exportVideo(
        { input: 'promo/renders/v1.mp4', preset: 'vertical-9x16', baseDir: workspace, scope: {} as never },
        deps(calls, { lookup: () => null }),
      ),
    ).toMatchObject({ ok: false, error: expect.stringMatching(/ffmpeg/u) });
    expect(calls).toHaveLength(0);
  });

  it('rótulo pedido sem fonte no sistema não exporta calado', async () => {
    writeNarration('nexus-clone');
    const result = await exportVideo(
      { input: 'promo/renders/v1.mp4', preset: 'vertical-9x16', baseDir: workspace, scope: {} as never },
      deps([], { fontCandidates: [path.join(workspace, 'nada.ttf')] }),
    );
    expect(result).toMatchObject({ ok: false, error: expect.stringMatching(/fonte/u) });
  });

  it('cancelado devolve canceled e não deixa arquivo parcial', async () => {
    const calls: OwnedProcessOptions[] = [];
    const result = await exportVideo(
      { input: 'promo/renders/v1.mp4', preset: 'vertical-9x16', baseDir: workspace, scope: {} as never },
      deps(calls, { run: async () => ({ exitCode: null, timedOut: false, aborted: true, tail: [] }) }),
    );
    expect(result).toMatchObject({ ok: false, canceled: true });
    expect(fs.existsSync(path.join(project, 'exports')) ? fs.readdirSync(path.join(project, 'exports')) : []).toEqual([]);
  });
});
