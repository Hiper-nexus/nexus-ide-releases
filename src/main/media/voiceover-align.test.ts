import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OwnedProcessOptions, OwnedProcessResult } from '../video/video-process';
import { videoEnginePaths } from '../video/video-engine';
import { findSyntheticSources } from '../video/video-export';
import { alignVoiceover, forcedAlignmentCostUsd, type AlignDeps } from './voiceover-align';

/** F-1602 — narração gravada pela própria pessoa, alinhada ao roteiro. */

let root: string;
let userData: string;
const scope = { projectId: 'p', checkoutId: 'c', rootRealPath: '' } as never;
const SCRIPT = 'O Claude escreve.\n\nBaixe em nexuside.app hoje.';

function wav(seconds: number): Buffer {
  const sampleRate = 16_000;
  const data = Buffer.alloc(sampleRate * 2 * seconds);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'latin1');
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8, 'latin1');
  header.write('fmt ', 12, 'latin1');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'latin1');
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

const RECOGNIZED = [
  ['O', 0, 0.2],
  ['Clôde', 0.2, 0.7],
  ['escreve.', 0.7, 1.3],
  ['Baixe', 1.6, 2.0],
  ['em', 2.0, 2.2],
  ['Nexus', 2.2, 2.6],
  ['e', 2.6, 2.7],
  ['de', 2.7, 2.8],
  ['ponto', 2.8, 3.1],
  ['app', 3.1, 3.4],
  ['hoje.', 3.5, 4.0],
] as const;

function deps(overrides: Partial<AlignDeps> = {}, calls: OwnedProcessOptions[] = []): AlignDeps {
  return {
    fetchFn: vi.fn(async () =>
      new Response(JSON.stringify({ words: RECOGNIZED.map(([text, start, end]) => ({ text, start, end, loss: 0.1 })), loss: 0.1 }), {
        status: 200,
      }),
    ) as unknown as typeof fetch,
    getKey: () => 'xi-test',
    userData,
    manifestDir: path.join(root, 'manifest'),
    pathValue: '/bin',
    baseEnv: { ELEVENLABS_API_KEY: 'segredo' },
    lookup: (command) => (command === 'node' ? '/bin/node' : null),
    acquirePermit: async () => ({ release: () => undefined }) as never,
    isHardened: () => false,
    resolveNode: async () => ({ execPath: '/bin/node', major: 22, version: 'v22' }) as never,
    ensureEngine: async () => ({ ok: true, installed: 'already' }) as never,
    run: async (opts): Promise<OwnedProcessResult> => {
      calls.push(opts);
      if (opts.args[1] === 'models') {
        fs.mkdirSync(path.join(videoEnginePaths(userData).home, '.cache', 'hyperframes', 'parakeet', 'parakeet-tdt-0.6b-v3-int8'), {
          recursive: true,
        });
        return { exitCode: 0, timedOut: false, aborted: false, tail: [] };
      }
      const dir = String(opts.args[opts.args.indexOf('-d') + 1]);
      fs.writeFileSync(
        path.join(dir, 'transcript.json'),
        JSON.stringify(RECOGNIZED.map(([text, start, end], index) => ({ id: `w${index}`, text, start, end }))),
      );
      return { exitCode: 0, timedOut: false, aborted: false, tail: [] };
    },
    ...overrides,
  };
}

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-align-')));
  userData = path.join(root, 'ud');
  (scope as { rootRealPath: string }).rootRealPath = root;
  fs.mkdirSync(path.join(root, 'promo', 'assets'), { recursive: true });
  fs.writeFileSync(path.join(root, 'promo', 'assets', 'minha-voz.wav'), wav(4));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('alinhamento da narração gravada', () => {
  it('ElevenLabs: preço antes, grafia do roteiro, mesma linha do tempo e legendas, voz gravada', async () => {
    const d = deps();
    const priced = await alignVoiceover(
      { audioPath: 'promo/assets/minha-voz.wav', script: SCRIPT, baseDir: root, scope, dryRun: true },
      d,
    );
    expect(priced).toEqual({ ok: true, dryRun: true, engine: 'elevenlabs', durationSec: 4, estimatedCostUsd: forcedAlignmentCostUsd(4) });
    expect(d.fetchFn).not.toHaveBeenCalled();

    const result = await alignVoiceover({ audioPath: 'promo/assets/minha-voz.wav', script: SCRIPT, baseDir: root, scope }, d);
    if (!result.ok) throw new Error(result.error);
    const [url, init] = (d.fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.elevenlabs.io/v1/forced-alignment');
    expect(init.headers).toEqual({ 'xi-api-key': 'xi-test' });
    expect((init.body as FormData).get('text')).toBe(SCRIPT);
    expect(result).toMatchObject({ engine: 'elevenlabs', words: 7, matchedRatio: 1, unmatchedWords: 0 });
    const timeline = JSON.parse(fs.readFileSync(result.files!.timeline, 'utf8')) as {
      generator: string;
      audio: string;
      voice: { origin: string };
      words: Array<{ text: string; startMs: number; endMs: number }>;
      synthetic?: unknown;
    };
    expect(timeline.generator).toBe('nexus_voiceover_align');
    expect(timeline.voice.origin).toBe('recorded');
    expect(timeline.synthetic).toBeUndefined();
    expect(timeline.audio).toBe('narration.wav');
    expect(timeline.words.map((word) => word.text)).toEqual(['O', 'Claude', 'escreve.', 'Baixe', 'em', 'nexuside.app', 'hoje.']);
    expect(timeline.words[5]).toMatchObject({ startMs: 2200, endMs: 3400 });
    expect(fs.readFileSync(result.files!.srt, 'utf8')).toContain('Claude escreve.');
    // The export takes the captions and burns no AI label for a recorded voice.
    const sources = findSyntheticSources(path.join(root, 'promo'));
    expect(sources.narration).toEqual([]);
    expect(sources.captions?.srt).toBe(result.files!.srt);
  });

  it('local: sem o modelo, pede o OK do operador; com o OK baixa, transcreve em pasta privada e alinha', async () => {
    const calls: OwnedProcessOptions[] = [];
    const d = deps({ getKey: () => undefined }, calls);
    const refused = await alignVoiceover({ audioPath: 'promo/assets/minha-voz.wav', script: SCRIPT, baseDir: root, scope }, d);
    expect(refused).toMatchObject({ ok: false, needsModelDownload: true, error: expect.stringMatching(/639 MB/u) });
    expect(calls).toHaveLength(0);

    const result = await alignVoiceover(
      { audioPath: 'promo/assets/minha-voz.wav', script: SCRIPT, baseDir: root, scope, allowModelDownload: true, language: 'pt' },
      d,
    );
    if (!result.ok) throw new Error(result.error);
    expect(calls.map((call) => call.args.slice(1, 3).join(' '))).toEqual(['models install', 'transcribe ' + path.join(root, 'promo', 'assets', 'minha-voz.wav')]);
    const transcribe = calls[1];
    expect(transcribe.args).toEqual(expect.arrayContaining(['--engine=parakeet', '--language=pt', '--json']));
    expect(transcribe.env.ELEVENLABS_API_KEY).toBeUndefined();
    const scratch = String(transcribe.args[transcribe.args.indexOf('-d') + 1]);
    expect(scratch.startsWith(videoEnginePaths(userData).workDir)).toBe(true);
    expect(fs.existsSync(scratch)).toBe(false);
    expect(result).toMatchObject({ engine: 'local', estimatedCostUsd: 0, matchedRatio: 1 });
    expect(fs.existsSync(path.join(root, 'promo', 'transcript.json'))).toBe(false);
  });

  it('áudio que não lê o roteiro sai com aviso; áudio fora do workspace ou formato estranho é recusado', async () => {
    const d = deps({
      fetchFn: (async () =>
        new Response(JSON.stringify({ words: [{ text: 'receita', start: 0, end: 1 }, { text: 'bolo', start: 1, end: 2 }] }), {
          status: 200,
        })) as unknown as typeof fetch,
    });
    const result = await alignVoiceover({ audioPath: 'promo/assets/minha-voz.wav', script: SCRIPT, baseDir: root, scope }, d);
    expect(result).toMatchObject({ ok: true, warnings: [expect.stringMatching(/confira se o áudio lê este roteiro/u), expect.any(String)] });
    expect(await alignVoiceover({ audioPath: '../fora.wav', script: SCRIPT, baseDir: root, scope }, d)).toMatchObject({ ok: false });
    fs.writeFileSync(path.join(root, 'promo', 'a.exe'), 'x');
    expect(await alignVoiceover({ audioPath: 'promo/a.exe', script: SCRIPT, baseDir: root, scope }, d)).toMatchObject({
      ok: false,
      error: expect.stringMatching(/formato de áudio/u),
    });
    expect(await alignVoiceover({ audioPath: 'promo/assets/minha-voz.wav', script: '  ', baseDir: root, scope }, d)).toMatchObject({
      ok: false,
      error: 'roteiro vazio',
    });
  });

  it('erro da ElevenLabs volta com o motivo; Hardened recusa o motor local', async () => {
    const d = deps({ fetchFn: (async () => new Response('{"detail":"bad"}', { status: 401 })) as unknown as typeof fetch });
    expect(await alignVoiceover({ audioPath: 'promo/assets/minha-voz.wav', script: SCRIPT, baseDir: root, scope }, d)).toMatchObject({
      ok: false,
      error: expect.stringMatching(/recusou a chave/u),
    });
    expect(
      await alignVoiceover(
        { audioPath: 'promo/assets/minha-voz.wav', script: SCRIPT, baseDir: root, scope, engine: 'local' },
        { ...deps(), isHardened: () => true },
      ),
    ).toMatchObject({ ok: false, error: expect.stringMatching(/Hardened/u) });
  });
});
