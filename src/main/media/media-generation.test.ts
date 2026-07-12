import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  findMediaProvider,
  resolveMediaModel,
  resolveMediaProvider,
  resolveOutPath,
} from './media-providers';
import {
  generateAudio,
  generateImage,
  generateVideo,
  replicateEndImageField,
  replicateImageField,
  replicateInput,
  type MediaDeps,
} from './media-generation';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-media-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const PNG_B64 = Buffer.from('fake-png-bytes').toString('base64');

function fakeDeps(
  responses: Array<{ status?: number; json?: unknown; body?: Buffer }>,
): { deps: MediaDeps; calls: Array<{ url: string; init?: RequestInit }> } {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const queue = [...responses];
  const deps: MediaDeps = {
    fetchFn: (async (url: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      const next = queue.shift();
      if (!next) throw new Error('fake fetch: fila vazia');
      const status = next.status ?? 200;
      if (next.body) {
        return new Response(new Uint8Array(next.body), { status });
      }
      return new Response(JSON.stringify(next.json ?? {}), {
        status,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch,
    resolveHostname: async () => ['93.184.216.34'],
    getKey: () => 'test-key',
    sleep: async () => {},
    now: () => 1_000,
  };
  return { deps, calls };
}

describe('resolveOutPath', () => {
  it('aceita caminho absoluto apenas dentro do workspace', () => {
    const inside = path.join(dir, 'x/y.png');
    expect(resolveOutPath(inside, dir, 'png')).toBe(inside);
    expect(() => resolveOutPath('/tmp/x/y.png', dir, 'png')).toThrow(/escapa/);
  });

  it('resolve relativo dentro do baseDir e rejeita escape', () => {
    expect(resolveOutPath('assets/a.png', dir, 'png')).toBe(
      path.join(dir, 'assets/a.png'),
    );
    expect(() => resolveOutPath('../fora.png', dir, 'png')).toThrow(/escapa/);
  });

  it('gera nome com timestamp quando omitido', () => {
    expect(resolveOutPath(undefined, dir, 'mp4', () => 42)).toBe(
      path.join(dir, 'generated-42.mp4'),
    );
  });
});

describe('resolveMediaProvider / resolveMediaModel', () => {
  it('cost routing: escolhe o provider mais barato com key', () => {
    const def = resolveMediaProvider('image', undefined, () => true);
    expect(def.id).toBe('google-image');
  });

  it('pula provider sem key', () => {
    const def = resolveMediaProvider(
      'image',
      undefined,
      (d) => d.id === 'openai-image',
    );
    expect(def.id).toBe('openai-image');
  });

  it('provider explícito sem key é erro, nunca substitui', () => {
    expect(() =>
      resolveMediaProvider('image', 'openai-image', () => false),
    ).toThrow(/sem key/);
  });

  it('provider de kind errado é erro', () => {
    expect(() =>
      resolveMediaProvider('video', 'google-image', () => true),
    ).toThrow(/não de video/);
  });

  it('modelo fora da whitelist é erro, sem fallback silencioso', () => {
    const def = findMediaProvider('replicate-video')!;
    expect(() => resolveMediaModel(def, 'sora-9')).toThrow(/não habilitado/);
    expect(resolveMediaModel(def, undefined)).toBe('bytedance/seedance-2.0');
  });
});

describe('generateImage', () => {
  it('rejeita input/output fora do workspace antes de chamar o provider', async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-media-outside-'));
    const outsideFile = path.join(outside, 'private.png');
    fs.writeFileSync(outsideFile, 'private');
    fs.symlinkSync(outsideFile, path.join(dir, 'escape.png'));
    const { deps, calls } = fakeDeps([]);

    await expect(
      generateImage(
        { prompt: 'x', baseDir: dir, imagePath: 'escape.png' },
        deps,
      ),
    ).rejects.toThrow(/escapa o workspace/);
    await expect(
      generateImage(
        { prompt: 'x', baseDir: dir, outPath: path.join(outside, 'out.png') },
        deps,
      ),
    ).rejects.toThrow(/escapa o workspace/);
    expect(calls).toHaveLength(0);
    fs.rmSync(outside, { recursive: true, force: true });
  });

  it('google-image: extrai inlineData e grava o arquivo', async () => {
    const { deps, calls } = fakeDeps([
      {
        json: {
          candidates: [
            {
              content: {
                parts: [
                  { text: 'aqui está' },
                  { inlineData: { mimeType: 'image/png', data: PNG_B64 } },
                ],
              },
            },
          ],
        },
      },
    ]);
    const result = await generateImage(
      { prompt: 'um gato', baseDir: dir, outPath: 'gato.png' },
      deps,
    );
    expect(result.provider).toBe('google-image');
    expect(result.estimatedCostUsd).toBe(0.039);
    expect(fs.readFileSync(result.path, 'utf8')).toBe('fake-png-bytes');
    expect(calls[0].url).toContain(
      'models/gemini-3.1-flash-image-preview:generateContent',
    );
    const headers = calls[0].init?.headers as Record<string, string>;
    expect(headers['x-goog-api-key']).toBe('test-key');
  });

  it('google-image: erro claro quando a resposta não tem imagem', async () => {
    const { deps } = fakeDeps([
      { json: { candidates: [{ content: { parts: [{ text: 'bloqueado' }] } }] } },
    ]);
    await expect(
      generateImage({ prompt: 'x', baseDir: dir }, deps),
    ).rejects.toThrow(/sem imagem/);
  });

  it('openai-image: usa b64_json e Bearer', async () => {
    const { deps, calls } = fakeDeps([
      { json: { data: [{ b64_json: PNG_B64 }] } },
    ]);
    const result = await generateImage(
      { prompt: 'logo', provider: 'openai-image', baseDir: dir },
      deps,
    );
    expect(result.model).toBe('gpt-image-2');
    expect(fs.existsSync(result.path)).toBe(true);
    const headers = calls[0].init?.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer test-key');
  });

  it('erro HTTP vira mensagem com status e corpo', async () => {
    const { deps } = fakeDeps([
      { status: 401, json: { error: { message: 'bad key' } } },
    ]);
    await expect(
      generateImage({ prompt: 'x', baseDir: dir }, deps),
    ).rejects.toThrow(/401/);
  });
});

describe('replicate adapters', () => {
  it('mapeia o campo de imagem por família (i2v silencioso se errado)', () => {
    expect(replicateImageField('bytedance/seedance-2.0')).toBe('image');
    expect(replicateImageField('google/veo-3.1')).toBe('image');
    expect(replicateImageField('kwaivgi/kling-v3-video')).toBe('start_image');
    expect(replicateImageField('minimax/hailuo-2.3')).toBe('first_frame_image');
    expect(replicateImageField('wan-video/wan-2.5-i2v')).toBe('image');
  });

  it('mapeia o last/end frame por família', () => {
    expect(replicateEndImageField('bytedance/seedance-2.0')).toBe(
      'last_frame_image',
    );
    expect(replicateEndImageField('google/veo-3.1-fast')).toBe('last_frame');
    expect(replicateEndImageField('kwaivgi/kling-v3-video')).toBe('end_image');
    expect(replicateEndImageField('minimax/hailuo-2.3')).toBeNull();
  });

  it('seedance: duration/resolution/aspect/audio + last_frame_image', () => {
    const start = {
      path: path.join(dir, 'a.png'),
      data: Buffer.from('start'),
    };
    const end = { path: path.join(dir, 'b.png'), data: Buffer.from('end') };
    const input = replicateInput(
      {
        prompt: 'cinematic pan',
        baseDir: dir,
        durationSeconds: 8,
        resolution: '1080p',
        aspectRatio: '9:16',
      },
      'bytedance/seedance-2.0',
      start,
      end,
    );
    expect(input.prompt).toBe('cinematic pan');
    expect(input.duration).toBe(8);
    expect(input.resolution).toBe('1080p');
    expect(input.aspect_ratio).toBe('9:16');
    expect(input.generate_audio).toBe(true);
    expect(String(input.image)).toMatch(/^data:image\/png;base64,/);
    expect(String(input.last_frame_image)).toMatch(/^data:image\/png;base64,/);
    expect(input).not.toHaveProperty('start_image');
  });

  it('veo-3.1-lite: sem generate_audio; last_frame no end', () => {
    const start = {
      path: path.join(dir, 'a.png'),
      data: Buffer.from('start'),
    };
    const end = { path: path.join(dir, 'b.png'), data: Buffer.from('end') };
    const input = replicateInput(
      { prompt: 'city night', baseDir: dir },
      'google/veo-3.1-lite',
      start,
      end,
    );
    expect(input.generate_audio).toBeUndefined();
    expect(input.image).toBeDefined();
    expect(input.last_frame).toBeDefined();
  });

  it('kling: start_image + end_image + mode a partir da resolution', () => {
    const start = {
      path: path.join(dir, 'a.png'),
      data: Buffer.from('start'),
    };
    const end = { path: path.join(dir, 'b.png'), data: Buffer.from('end') };
    const input = replicateInput(
      {
        prompt: 'face turn',
        baseDir: dir,
        durationSeconds: 5,
        resolution: '1080p',
      },
      'kwaivgi/kling-v3-video',
      start,
      end,
    );
    expect(input.start_image).toBeDefined();
    expect(input.end_image).toBeDefined();
    expect(input.mode).toBe('pro');
    expect(input).not.toHaveProperty('image');
  });
});

describe('generateVideo', () => {
  it('replicate: cria prediction, faz poll até succeeded e baixa o mp4', async () => {
    const { deps, calls } = fakeDeps([
      { json: { id: 'pred-1', status: 'starting' } },
      { json: { id: 'pred-1', status: 'processing' } },
      {
        json: {
          id: 'pred-1',
          status: 'succeeded',
          output: 'https://replicate.delivery/x.mp4',
        },
      },
      { body: Buffer.from('fake-mp4') },
    ]);
    const result = await generateVideo(
      { prompt: 'drone sobre a praia', baseDir: dir, outPath: 'praia.mp4' },
      deps,
    );
    expect(result.provider).toBe('replicate-video');
    expect(fs.readFileSync(result.path, 'utf8')).toBe('fake-mp4');
    expect(calls[0].url).toContain(
      '/v1/models/bytedance/seedance-2.0/predictions',
    );
    expect(calls[1].url).toContain('/v1/predictions/pred-1');
  });

  it('replicate veo-3.1: usa o slug correto na prediction', async () => {
    const { deps, calls } = fakeDeps([
      { json: { id: 'pred-veo', status: 'starting' } },
      {
        json: {
          id: 'pred-veo',
          status: 'succeeded',
          output: 'https://replicate.delivery/veo.mp4',
        },
      },
      { body: Buffer.from('veo-mp4') },
    ]);
    const result = await generateVideo(
      {
        prompt: 'slow dolly',
        baseDir: dir,
        model: 'google/veo-3.1',
        outPath: 'veo.mp4',
      },
      deps,
    );
    expect(result.model).toBe('google/veo-3.1');
    expect(calls[0].url).toContain('/v1/models/google/veo-3.1/predictions');
    const body = JSON.parse(String(calls[0].init?.body ?? '{}')) as {
      input: Record<string, unknown>;
    };
    expect(body.input.generate_audio).toBe(true);
    expect(body.input.resolution).toBe('720p');
  });

  it('replicate: prediction failed vira erro com a causa', async () => {
    const { deps } = fakeDeps([
      { json: { id: 'p2', status: 'starting' } },
      { json: { id: 'p2', status: 'failed', error: 'nsfw filter' } },
    ]);
    await expect(
      generateVideo({ prompt: 'x', baseDir: dir }, deps),
    ).rejects.toThrow(/nsfw filter/);
  });
});

describe('generateAudio', () => {
  it('elevenlabs: grava o mp3 e estima custo por caractere', async () => {
    const { deps, calls } = fakeDeps([{ body: Buffer.from('fake-mp3') }]);
    const result = await generateAudio(
      { text: 'Olá, mundo!', baseDir: dir, outPath: 'ola.mp3' },
      deps,
    );
    expect(result.provider).toBe('elevenlabs');
    expect(fs.readFileSync(result.path, 'utf8')).toBe('fake-mp3');
    // custo arredondado a 4 casas: (11/1000)*0.18 = 0.00198 → 0.002
    expect(result.estimatedCostUsd).toBe(0.002);
    expect(calls[0].url).toContain('/v1/text-to-speech/');
    const headers = calls[0].init?.headers as Record<string, string>;
    expect(headers['xi-api-key']).toBe('test-key');
  });
});
