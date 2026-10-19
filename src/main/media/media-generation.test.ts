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
  MediaJobInterruptedError,
  MediaJobTimeoutError,
  replicateEndImageField,
  replicateImageField,
  replicateInput,
  seedreamInput,
  type MediaDeps,
} from './media-generation';
import { getVideoJob, saveVideoJob } from './media-video-jobs';
import { MediaProviderHttpError } from './media-errors';

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
    ).toThrow(/sem chave — conecte em Ajustes → Serviços de mídia/);
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
    const outside = fs.mkdtempSync(
      path.join(os.tmpdir(), 'nexus-media-outside-'),
    );
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
      {
        json: { candidates: [{ content: { parts: [{ text: 'bloqueado' }] } }] },
      },
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

  it('F-1584: chave recusada diz o que fazer, com a frase do serviço e sem o JSON cru', async () => {
    const { deps } = fakeDeps([
      { status: 401, json: { error: { code: 401, message: 'API key not valid.' } } },
    ]);
    const err = await generateImage({ prompt: 'x', baseDir: dir }, deps).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MediaProviderHttpError);
    expect((err as MediaProviderHttpError).kind).toBe('key');
    expect((err as Error).message).toBe(
      'Google recusou a chave (HTTP 401). Confira ou troque a chave em Ajustes → Serviços de mídia. Resposta do serviço: API key not valid.',
    );
  });
});

describe('F-1584: falha do Replicate legível', () => {
  it('parâmetro recusado (422) traz o campo recusado, não o corpo inteiro', async () => {
    const { deps } = fakeDeps([
      {
        status: 422,
        json: {
          title: 'Input validation failed',
          detail: '- input.duration: duration must be one of the following: 4, 6, 8',
          status: 422,
        },
      },
    ]);
    await expect(
      generateVideo({ prompt: 'x', model: 'google/veo-3.1', durationSeconds: 8, baseDir: dir }, deps),
    ).rejects.toThrow(
      'Replicate não aceitou o pedido (HTTP 422); nada foi gerado. Resposta do serviço: - input.duration: duration must be one of the following: 4, 6, 8',
    );
  });

  it('prediction que falha no serviço diz que não concluiu, com a causa', async () => {
    const { deps } = fakeDeps([
      { json: { id: 'p9', status: 'starting' } },
      { json: { id: 'p9', status: 'failed', error: 'E005: flagged as sensitive' } },
    ]);
    await expect(generateVideo({ prompt: 'x', baseDir: dir }, deps)).rejects.toThrow(
      'Replicate não concluiu a geração (falhou): E005: flagged as sensitive',
    );
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

  it('seedance: aceita reference_images', () => {
    const refs = [
      { path: path.join(dir, 'r1.png'), data: Buffer.from('r1') },
      { path: path.join(dir, 'r2.png'), data: Buffer.from('r2') },
    ];
    const input = replicateInput(
      { prompt: 'hero walks', baseDir: dir },
      'bytedance/seedance-2.0',
      undefined,
      undefined,
      refs,
    );
    expect(Array.isArray(input.reference_images)).toBe(true);
    expect((input.reference_images as string[]).length).toBe(2);
  });

  it('sora: seconds + openai_api_key + input_reference', () => {
    const start = {
      path: path.join(dir, 'a.png'),
      data: Buffer.from('start'),
    };
    const input = replicateInput(
      { prompt: 'city', baseDir: dir, durationSeconds: 8, aspectRatio: '16:9' },
      'openai/sora-2',
      start,
      undefined,
      [],
      'sk-test',
    );
    expect(input.seconds).toBe(8);
    expect(input.openai_api_key).toBe('sk-test');
    expect(input.input_reference).toBeDefined();
    // F-1585: o schema do Sora só aceita portrait|landscape.
    expect(input.aspect_ratio).toBe('landscape');
  });

  it('F-1585: Sora Pro traduz 720p/1024p para standard/high; 9:16 vira portrait', () => {
    const input = replicateInput(
      { prompt: 'city', baseDir: dir, durationSeconds: 12, aspectRatio: '9:16', resolution: '1024p' },
      'openai/sora-2-pro',
    );
    expect(input).toMatchObject({ seconds: 12, aspect_ratio: 'portrait', resolution: 'high' });
  });

  it('F-1585: Veo sem duração usa o padrão do modelo (8 s), nunca 5 s', () => {
    const input = replicateInput({ prompt: 'x', baseDir: dir }, 'google/veo-3.1');
    expect(input.duration).toBe(8);
    expect(input.resolution).toBe('720p');
  });

  it('F-1585: Wan recebe duração e resolução pedidas (antes eram descartadas)', () => {
    const input = replicateInput(
      { prompt: 'x', baseDir: dir, durationSeconds: 10, resolution: '1080p' },
      'wan-video/wan-2.5-i2v',
    );
    expect(input).toMatchObject({ duration: 10, resolution: '1080p' });
  });

  it('luma: start_image + end_image', () => {
    const start = {
      path: path.join(dir, 'a.png'),
      data: Buffer.from('start'),
    };
    const end = { path: path.join(dir, 'b.png'), data: Buffer.from('end') };
    expect(replicateImageField('luma/ray-3.2')).toBe('start_image');
    expect(replicateEndImageField('luma/ray-3.2')).toBe('end_image');
    const input = replicateInput(
      { prompt: 'dolly', baseDir: dir },
      'luma/ray-3.2',
      start,
      end,
    );
    expect(input.start_image).toBeDefined();
    expect(input.end_image).toBeDefined();
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

  it('replicate: timeout inclui recoverJobId e persiste o job', async () => {
    // Polling 90× até o timeout é custoso; o caminho de recovery é coberto
    // aqui: job salvo + recoverJobId retoma sem recriar a prediction.
    const { deps, calls } = fakeDeps([
      { json: { id: 'pred-recover', status: 'starting' } },
      {
        json: {
          id: 'pred-recover',
          status: 'succeeded',
          output: 'https://replicate.delivery/recovered.mp4',
        },
      },
      { body: Buffer.from('recovered-mp4') },
    ]);
    // Pretend a prior timeout left the job on disk.
    saveVideoJob(dir, {
      jobId: 'pred-recover',
      provider: 'replicate-video',
      pollTarget: 'https://api.replicate.com/v1/predictions/pred-recover',
      model: 'bytedance/seedance-2.0',
      prompt: 'old',
      startedAt: 1,
      status: 'pending',
    });
    const result = await generateVideo(
      {
        prompt: '',
        baseDir: dir,
        recoverJobId: 'pred-recover',
        outPath: 'recovered.mp4',
      },
      deps,
    );
    expect(fs.readFileSync(result.path, 'utf8')).toBe('recovered-mp4');
    expect(result.jobId).toBe('pred-recover');
    expect(getVideoJob(dir, 'pred-recover')?.status).toBe('completed');
    // recover must not create a new prediction
    expect(calls[0].url).toContain('/v1/predictions/pred-recover');
    expect(calls[0].url).not.toContain('/models/');
  });

  it('replicate: submit persiste jobId para recovery futuro', async () => {
    const { deps } = fakeDeps([
      { json: { id: 'pred-new', status: 'starting' } },
      {
        json: {
          id: 'pred-new',
          status: 'succeeded',
          output: 'https://replicate.delivery/new.mp4',
        },
      },
      { body: Buffer.from('new-mp4') },
    ]);
    const result = await generateVideo(
      { prompt: 'scene', baseDir: dir, outPath: 'new.mp4' },
      deps,
    );
    expect(result.jobId).toBe('pred-new');
    expect(getVideoJob(dir, 'pred-new')?.status).toBe('completed');
  });

  it('google-video: predictLongRunning + poll + bytesBase64', async () => {
    const { deps, calls } = fakeDeps([
      { json: { name: 'operations/veo-op-1' } },
      {
        json: {
          done: true,
          response: {
            generateVideoResponse: {
              generatedSamples: [
                {
                  video: {
                    bytesBase64Encoded:
                      Buffer.from('veo-bytes').toString('base64'),
                  },
                },
              ],
            },
          },
        },
      },
    ]);
    const result = await generateVideo(
      {
        prompt: 'golden retriever',
        baseDir: dir,
        provider: 'google-video',
        model: 'veo-3.1-generate-preview',
        outPath: 'native-veo.mp4',
      },
      deps,
    );
    expect(result.provider).toBe('google-video');
    expect(fs.readFileSync(result.path, 'utf8')).toBe('veo-bytes');
    expect(calls[0].url).toContain(
      'models/veo-3.1-generate-preview:predictLongRunning',
    );
    expect(calls[1].url).toContain('operations/veo-op-1');
  });

  it('MediaJobTimeoutError carrega jobId', () => {
    const err = new MediaJobTimeoutError('replicate-video', 'abc');
    expect(err.jobId).toBe('abc');
    expect(err.message).toMatch(/recoverJobId="abc"/);
  });

  it('seedance rejeita reference_images + keyframes juntos', () => {
    const start = {
      path: path.join(dir, 'a.png'),
      data: Buffer.from('start'),
    };
    const ref = { path: path.join(dir, 'r.png'), data: Buffer.from('ref') };
    expect(() =>
      replicateInput(
        { prompt: 'x', baseDir: dir },
        'bytedance/seedance-2.0',
        start,
        undefined,
        [ref],
      ),
    ).toThrow(/reference_images não pode combinar/);
  });
});

describe('seedream (Seedream 5.0 Pro image)', () => {
  it('monta input com size 2K e aspect_ratio oficiais', () => {
    const input = seedreamInput(
      {
        prompt: 'hero portrait',
        baseDir: dir,
        aspectRatio: '9:16',
        size: '2K',
      },
      'bytedance/seedream-5-pro',
    );
    expect(input.prompt).toBe('hero portrait');
    expect(input.size).toBe('2K');
    expect(input.aspect_ratio).toBe('9:16');
    expect(input.output_format).toBe('png');
  });

  it('rejeita size 4K no Seedream 5.0 Pro (schema só 1K|2K)', () => {
    expect(() =>
      seedreamInput(
        { prompt: 'x', baseDir: dir, size: '4K' },
        'bytedance/seedream-5-pro',
      ),
    ).toThrow(/1K ou 2K/);
  });

  it('image_input recebe data URIs de referência (até 10)', () => {
    const imgs = [
      { path: path.join(dir, 'a.png'), data: Buffer.from('a') },
      { path: path.join(dir, 'b.png'), data: Buffer.from('b') },
    ];
    const input = seedreamInput(
      { prompt: 'same character', baseDir: dir },
      'bytedance/seedream-5-pro',
      imgs,
    );
    expect(Array.isArray(input.image_input)).toBe(true);
    expect((input.image_input as string[]).length).toBe(2);
    expect(input.aspect_ratio).toBe('match_input_image');
  });

  it('generateImage via replicate-image faz prediction e baixa png', async () => {
    const { deps, calls } = fakeDeps([
      { json: { id: 'img-1', status: 'starting' } },
      {
        json: {
          id: 'img-1',
          status: 'succeeded',
          output: 'https://replicate.delivery/seedream.png',
        },
      },
      { body: Buffer.from('seedream-png') },
    ]);
    const result = await generateImage(
      {
        prompt: 'cinematic still',
        baseDir: dir,
        provider: 'replicate-image',
        model: 'seedream',
        outPath: 'hero.png',
      },
      deps,
    );
    expect(result.provider).toBe('replicate-image');
    expect(result.model).toBe('bytedance/seedream-5-pro');
    expect(fs.readFileSync(result.path, 'utf8')).toBe('seedream-png');
    expect(calls[0].url).toContain(
      '/v1/models/bytedance/seedream-5-pro/predictions',
    );
    const body = JSON.parse(String(calls[0].init?.body ?? '{}')) as {
      input: Record<string, unknown>;
    };
    expect(body.input.size).toBe('2K');
  });
});

describe('generateImage aspectRatio', () => {
  it('google-image: envia imageConfig.aspectRatio', async () => {
    const { deps, calls } = fakeDeps([
      {
        json: {
          candidates: [
            {
              content: {
                parts: [{ inlineData: { data: PNG_B64 } }],
              },
            },
          ],
        },
      },
    ]);
    await generateImage(
      {
        prompt: 'wide landscape',
        baseDir: dir,
        aspectRatio: '16:9',
        outPath: 'wide.png',
      },
      deps,
    );
    const body = JSON.parse(String(calls[0].init?.body ?? '{}')) as {
      generationConfig: { imageConfig?: { aspectRatio?: string } };
    };
    expect(body.generationConfig.imageConfig?.aspectRatio).toBe('16:9');
  });

  it('openai-image: mapeia 16:9 para size 1536x1024', async () => {
    const { deps, calls } = fakeDeps([
      {
        json: {
          data: [{ b64_json: PNG_B64 }],
        },
      },
    ]);
    await generateImage(
      {
        prompt: 'wide',
        baseDir: dir,
        provider: 'openai-image',
        aspectRatio: '16:9',
        outPath: 'oai.png',
      },
      deps,
    );
    const body = JSON.parse(String(calls[0].init?.body ?? '{}')) as {
      size?: string;
    };
    expect(body.size).toBe('1536x1024');
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

describe('estimateCost — vídeo/imagem nunca invisível a $0', () => {
  it('replicate-video estima por segundo com fallback sensato', () => {
    const def = findMediaProvider('replicate-video')!;
    expect(def.estimateCost({ model: 'google/veo-3.1', seconds: 10 })).toBe(4);
    // modelo sem tabela → fallback por segundo × default 5s
    expect(def.estimateCost({ model: 'kwaivgi/kling-v2.1' })).toBe(0.25);
  });

  it('google-video estima por segundo e resolução (preço de lista do Gemini)', () => {
    const def = findMediaProvider('google-video')!;
    expect(
      def.estimateCost({ model: 'veo-3.1-generate-preview', seconds: 8 }),
    ).toBe(3.2);
    expect(
      def.estimateCost({ model: 'veo-3.1-fast-generate-preview', seconds: 8, resolution: '4k' }),
    ).toBe(2.4);
    // F-1585: o Google desligou o Veo 2 em 30/06/2026 — saiu da lista.
    expect(def.models).not.toContain('veo-2.0-generate-001');
  });

  it('F-1585: replicate-video usa o preço de lista por resolução', () => {
    const def = findMediaProvider('replicate-video')!;
    expect(def.estimateCost({ model: 'bytedance/seedance-2.0', seconds: 5 })).toBe(0.9);
    expect(def.estimateCost({ model: 'bytedance/seedance-2.0', seconds: 5, resolution: '1080p' })).toBe(2.25);
    // Hailuo e Ray cobram por vídeo, não por segundo.
    expect(def.estimateCost({ model: 'minimax/hailuo-2.3', seconds: 10, resolution: '768p' })).toBe(0.56);
    expect(def.estimateCost({ model: 'luma/ray-3.2', seconds: 10, resolution: '1080p' })).toBe(3.6);
  });

  it('replicate-image (Seedream) tem estimativa flat por modelo', () => {
    const def = findMediaProvider('replicate-image')!;
    expect(def.estimateCost({ model: 'bytedance/seedream-5-pro' })).toBe(0.04);
    expect(def.estimateCost({ model: 'bytedance/seedream-3' })).toBe(0.03);
  });
});

describe('MediaJobTimeoutError — hint de recovery só quando recuperável', () => {
  it('vídeo (default) promete recoverJobId', () => {
    const err = new MediaJobTimeoutError('replicate-video', 'job-1');
    expect(err.recoverable).toBe(true);
    expect(err.message).toContain('recoverJobId="job-1"');
  });

  it('imagem não promete recoverJobId (job nunca é persistido)', () => {
    const err = new MediaJobTimeoutError('replicate-image', 'job-2', false);
    expect(err.recoverable).toBe(false);
    expect(err.message).not.toContain('recoverJobId=');
    expect(err.message).toContain('job-2');
  });
});

describe('generateImage — referenceImagePaths fail-loud fora do Seedream', () => {
  it('google-image rejeita refs extras em vez de descartar em silêncio', async () => {
    const { deps } = fakeDeps([]);
    await expect(
      generateImage(
        {
          prompt: 'x',
          baseDir: dir,
          provider: 'google-image',
          referenceImagePaths: ['a.png'],
        },
        deps,
      ),
    ).rejects.toThrow(/referenceImagePaths só é suportado em replicate-image/);
  });

  it('openai-image idem', async () => {
    const { deps } = fakeDeps([]);
    await expect(
      generateImage(
        {
          prompt: 'x',
          baseDir: dir,
          provider: 'openai-image',
          referenceImagePaths: ['a.png', 'b.png'],
        },
        deps,
      ),
    ).rejects.toThrow(/referenceImagePaths só é suportado em replicate-image/);
  });
});

describe('cancelamento (AbortSignal)', () => {
  it('generateImage aborta antes de chamar o provider', async () => {
    const { deps, calls } = fakeDeps([]);
    await expect(
      generateImage(
        { prompt: 'x', baseDir: dir, signal: AbortSignal.abort() },
        deps,
      ),
    ).rejects.toThrow(/cancelada/);
    expect(calls).toHaveLength(0);
  });

  it('generateVideo para de pollar quando abortado e NÃO marca o job failed', async () => {
    const controller = new AbortController();
    const { deps } = fakeDeps([
      { json: { id: 'pred-abort', status: 'starting' } },
      { json: { id: 'pred-abort', status: 'processing' } },
    ]);
    // aborta durante o primeiro sleep do poll loop
    deps.sleep = async () => {
      controller.abort();
    };
    await expect(
      generateVideo(
        {
          prompt: 'x',
          baseDir: dir,
          provider: 'replicate-video',
          signal: controller.signal,
        },
        deps,
      ),
    ).rejects.toThrow(/cancelada/);
    // abort ≠ failure: o job segue pendente e recuperável
    expect(getVideoJob(dir, 'pred-abort')?.status).toBe('pending');
  });

  it('generateAudio aborta antes do TTS', async () => {
    const { deps, calls } = fakeDeps([]);
    await expect(
      generateAudio(
        { text: 'x', baseDir: dir, signal: AbortSignal.abort() },
        deps,
      ),
    ).rejects.toThrow(/cancelada/);
    expect(calls).toHaveLength(0);
  });

  it('revogação após resposta do provider impede publicar imagem', async () => {
    const { deps, calls } = fakeDeps([
      {
        json: {
          candidates: [
            {
              content: {
                parts: [{ inlineData: { data: PNG_B64 } }],
              },
            },
          ],
        },
      },
    ]);
    const providerFetch = deps.fetchFn;
    let current = true;
    deps.fetchFn = (async (url: RequestInfo | URL, init?: RequestInit) => {
      const response = await providerFetch(url, init);
      current = false;
      return response;
    }) as typeof fetch;

    await expect(
      generateImage(
        {
          prompt: 'x',
          baseDir: dir,
          outPath: 'revoked.png',
          assertCurrentAuthority: () => {
            if (!current) throw new Error('session_authority_revoked');
          },
        },
        deps,
      ),
    ).rejects.toThrow('session_authority_revoked');
    expect(calls).toHaveLength(1);
    expect(fs.existsSync(path.join(dir, 'revoked.png'))).toBe(false);
  });

  it('revogação após submit preserva job remoto pendente sem output', async () => {
    const { deps, calls } = fakeDeps([
      { json: { id: 'pred-revoked', status: 'starting' } },
    ]);
    const providerFetch = deps.fetchFn;
    let current = true;
    deps.fetchFn = (async (url: RequestInfo | URL, init?: RequestInit) => {
      const response = await providerFetch(url, init);
      current = false;
      return response;
    }) as typeof fetch;

    await expect(
      generateVideo(
        {
          prompt: 'x',
          baseDir: dir,
          outPath: 'revoked.mp4',
          provider: 'replicate-video',
          assertCurrentAuthority: () => {
            if (!current) throw new Error('session_authority_revoked');
          },
        },
        deps,
      ),
    ).rejects.toThrow('session_authority_revoked');
    expect(calls).toHaveLength(1);
    expect(getVideoJob(dir, 'pred-revoked')).toMatchObject({
      status: 'pending',
      provider: 'replicate-video',
    });
    expect(fs.existsSync(path.join(dir, 'revoked.mp4'))).toBe(false);
  });
});

describe('F-1585: pedido de vídeo que o modelo recusa não chega ao serviço', () => {
  it('Veo com 5 s (o padrão antigo do Estúdio) é recusado antes de qualquer chamada', async () => {
    const { deps, calls } = fakeDeps([]);
    await expect(
      generateVideo({ prompt: 'x', model: 'google/veo-3.1', durationSeconds: 5, baseDir: dir }, deps),
    ).rejects.toThrow('google/veo-3.1 aceita 4, 6, 8 segundos (pedido: 5 s).');
    expect(calls).toHaveLength(0);
  });

  it('modelo do Gemini desligado diz quando e o que usar, sem chamar o Google', async () => {
    const { deps, calls } = fakeDeps([]);
    deps.now = () => Date.parse('2026-10-23T10:00:00Z');
    await expect(
      generateVideo(
        { prompt: 'x', provider: 'google-video', model: 'veo-3.1-generate-preview', baseDir: dir },
        deps,
      ),
    ).rejects.toThrow(
      'O fornecedor desligou o veo-3.1-generate-preview em 22/10/2026; ' +
        'use gemini-omni-1.1-flash, com a mesma chave do Gemini.',
    );
    expect(calls).toHaveLength(0);
  });

  it('sem duração, o Veo pelo Replicate recebe 8 s e o custo usa 8 s', async () => {
    const { deps, calls } = fakeDeps([
      { json: { id: 'pv', status: 'succeeded', output: 'https://replicate.delivery/v.mp4' } },
      { body: Buffer.from('mp4') },
    ]);
    const result = await generateVideo({ prompt: 'x', model: 'google/veo-3.1', baseDir: dir }, deps);
    const body = JSON.parse(String(calls[0].init?.body ?? '{}')) as { input: Record<string, unknown> };
    expect(body.input.duration).toBe(8);
    expect(result.estimatedCostUsd).toBe(3.2);
  });
});

/** MP4 mínimo com `moov/mvhd` dizendo a duração (o que o Omni devolve tem). */
function fakeMp4(seconds: number): Buffer {
  const box = (type: string, payload: Buffer): Buffer => {
    const header = Buffer.alloc(8);
    header.writeUInt32BE(8 + payload.length, 0);
    header.write(type, 4, 'latin1');
    return Buffer.concat([header, payload]);
  };
  const mvhd = Buffer.alloc(100);
  mvhd.writeUInt32BE(1000, 12);
  mvhd.writeUInt32BE(Math.round(seconds * 1000), 16);
  return Buffer.concat([
    box('ftyp', Buffer.from('isom', 'latin1')),
    box('moov', box('mvhd', mvhd)),
    box('mdat', Buffer.from('omni-frames')),
  ]);
}

const GEMINI = 'https://generativelanguage.googleapis.com/v1beta';

function omniInteraction(content: unknown[], extra: Record<string, unknown> = {}) {
  return {
    id: 'v1_omni-1',
    status: 'completed',
    model: 'gemini-omni-1.1-flash',
    object: 'interaction',
    steps: [
      { type: 'user_input', content: [{ type: 'text', text: 'x' }] },
      { type: 'thought', content: [{ type: 'thought', text: '...' }] },
      { type: 'model_output', content },
    ],
    ...extra,
  };
}

/** `usage` da geração real de 19/10/2026 (360p, 10 s, prompt de 22 tokens). */
const LIVE_USAGE = {
  total_tokens: 19636,
  total_input_tokens: 22,
  input_tokens_by_modality: [{ modality: 'text', tokens: 22 }],
  total_cached_tokens: 0,
  total_output_tokens: 19310,
  output_tokens_by_modality: [{ modality: 'video', tokens: 19310 }],
  total_tool_use_tokens: 0,
  total_thought_tokens: 304,
};

describe('F-1587: Gemini Omni Flash pelo google-video', () => {
  it('texto → vídeo: POST /interactions sem duração, Files API até ACTIVE e custo pelos tokens cobrados', async () => {
    const mp4 = fakeMp4(8);
    const { deps, calls } = fakeDeps([
      {
        json: omniInteraction(
          [
            {
              type: 'video',
              mime_type: 'video/mp4',
              uri: `${GEMINI}/files/omni123:download?alt=media`,
            },
          ],
          { usage: LIVE_USAGE, service_tier: 'standard' },
        ),
      },
      { json: { name: 'files/omni123', state: 'PROCESSING' } },
      { json: { name: 'files/omni123', state: 'ACTIVE' } },
      { body: mp4 },
    ]);
    const result = await generateVideo(
      {
        prompt: 'um gato no telhado',
        provider: 'google-video',
        aspectRatio: '9:16',
        resolution: '1080p',
        outPath: 'omni.mp4',
        baseDir: dir,
      },
      deps,
    );

    expect(calls[0]?.url).toBe(`${GEMINI}/interactions`);
    expect(calls[0]?.init?.method).toBe('POST');
    expect(new Headers(calls[0]?.init?.headers).get('x-goog-api-key')).toBe('test-key');
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      model: 'gemini-omni-1.1-flash',
      input: 'um gato no telhado',
      response_format: { type: 'video', delivery: 'uri', aspect_ratio: '9:16', resolution: '1080p' },
      generation_config: { video_config: { task: 'text_to_video' } },
      // O Google recusa entrega por URI sem guardar a interação (HTTP 400 ao
      // vivo em 19/10/2026: "store=true is required when response format has
      // video delivery set to URI").
      store: true,
    });
    expect(calls[1]?.url).toBe(`${GEMINI}/files/omni123`);
    expect(calls[2]?.url).toBe(`${GEMINI}/files/omni123`);
    expect(calls[3]?.url).toBe(`${GEMINI}/files/omni123:download?alt=media`);
    expect(new Headers(calls[3]?.init?.headers).get('x-goog-api-key')).toBe('test-key');

    expect(fs.readFileSync(result.path)).toEqual(mp4);
    expect(result).toMatchObject({
      provider: 'google-video',
      model: 'gemini-omni-1.1-flash',
      videoDurationSeconds: 8,
      // Pelos tokens cobrados, não pela tabela por segundo: 22 × $1.50/M +
      // 304 × $9/M (raciocínio) + 19.310 × $17.50/M (vídeo) = $0.3407.
      estimatedCostUsd: 0.3407,
      jobId: 'v1_omni-1',
    });
    expect(getVideoJob(dir, 'v1_omni-1')).toMatchObject({
      pollTarget: 'files/omni123',
      status: 'completed',
    });
  });

  it('vídeo em base64 na resposta é gravado sem outra chamada; padrão 720p', async () => {
    const mp4 = fakeMp4(6.5);
    const { deps, calls } = fakeDeps([
      {
        json: omniInteraction([
          { type: 'video', mime_type: 'video/mp4', data: mp4.toString('base64') },
        ]),
      },
    ]);
    const result = await generateVideo(
      { prompt: 'onda', model: 'omni', outPath: 'inline.mp4', baseDir: dir },
      deps,
    );
    expect(calls).toHaveLength(1);
    const body = JSON.parse(String(calls[0]?.init?.body)) as Record<string, unknown>;
    expect(body.response_format).toEqual({ type: 'video', delivery: 'uri', resolution: '720p' });
    expect(fs.readFileSync(result.path)).toEqual(mp4);
    expect(result.estimatedCostUsd).toBe(0.65);
    expect(result.videoDurationSeconds).toBe(6.5);
    // Sem job salvo, não há o que retomar: nenhum jobId prometido.
    expect(result.jobId).toBeUndefined();
  });

  it('duração no pedido é recusada antes de chamar o Google (a API não tem esse campo)', async () => {
    const { deps, calls } = fakeDeps([]);
    await expect(
      generateVideo(
        { prompt: 'x', provider: 'google-video', durationSeconds: 8, baseDir: dir },
        deps,
      ),
    ).rejects.toThrow('gemini-omni-1.1-flash não deixa escolher a duração (o modelo decide)');
    await expect(
      generateVideo({ prompt: 'x', model: 'omni', resolution: '480p', baseDir: dir }, deps),
    ).rejects.toThrow('aceita resolução 360p, 720p, 1080p, 4k (pedido: 480p)');
    expect(calls).toHaveLength(0);
  });

  it('imagem inicial vai antes do texto, com o papel declarado no prompt', async () => {
    fs.writeFileSync(path.join(dir, 'start.png'), 'start-png');
    const { deps, calls } = fakeDeps([
      { json: omniInteraction([{ type: 'video', data: fakeMp4(4).toString('base64') }]) },
    ]);
    await generateVideo(
      { prompt: 'anime esta cena', model: 'omni', imagePath: 'start.png', baseDir: dir },
      deps,
    );
    const body = JSON.parse(String(calls[0]?.init?.body)) as Record<string, unknown>;
    expect(body.input).toEqual([
      { type: 'image', data: Buffer.from('start-png').toString('base64'), mime_type: 'image/png' },
      { type: 'text', text: '[# Sources <FIRST_FRAME>@Image1]\nanime esta cena' },
    ]);
    expect(body.generation_config).toEqual({ video_config: { task: 'image_to_video' } });
  });

  it('resposta sem vídeo diz o que o modelo respondeu e não grava nada', async () => {
    const { deps } = fakeDeps([
      {
        json: omniInteraction([{ type: 'text', text: 'Não posso gerar   este vídeo.' }], {
          status: 'incomplete',
        }),
      },
    ]);
    await expect(
      generateVideo({ prompt: 'x', model: 'omni', outPath: 'nada.mp4', baseDir: dir }, deps),
    ).rejects.toThrow(
      'O Google não devolveu vídeo (status: incomplete); nada foi salvo. ' +
        'O modelo respondeu: "Não posso gerar este vídeo."',
    );
    expect(fs.existsSync(path.join(dir, 'nada.mp4'))).toBe(false);
  });

  it('arquivo FAILED na Files API vira erro e o job fica failed', async () => {
    const { deps } = fakeDeps([
      { json: omniInteraction([{ type: 'video', uri: 'files/bad1' }]) },
      { json: { state: 'FAILED', error: { message: 'processing error' } } },
    ]);
    await expect(generateVideo({ prompt: 'x', model: 'omni', baseDir: dir }, deps)).rejects.toThrow(
      'O Google não concluiu o arquivo do vídeo (Files API: FAILED) — processing error.',
    );
    expect(getVideoJob(dir, 'v1_omni-1')?.status).toBe('failed');
  });

  it('revisão #145 (P1): falha passageira depois de gerar deixa o job retomável, com o recoverJobId', async () => {
    // Files API com 503 no meio da espera: o vídeo já foi gerado e cobrado.
    const polling = fakeDeps([
      { json: omniInteraction([{ type: 'video', uri: 'files/flaky1' }]) },
      { status: 503, json: { error: { code: 503, message: 'The service is currently unavailable.' } } },
    ]);
    const first = await generateVideo({ prompt: 'x', model: 'omni', baseDir: dir }, polling.deps).catch(
      (err: unknown) => err,
    );
    expect(first).toBeInstanceOf(MediaJobInterruptedError);
    expect(first).toBeInstanceOf(MediaJobTimeoutError);
    expect((first as MediaJobTimeoutError).jobId).toBe('v1_omni-1');
    expect((first as MediaJobTimeoutError).recoverable).toBe(true);
    expect((first as Error).message).toContain('o vídeo já foi gerado, mas não chegou');
    expect((first as Error).message).toContain('recoverJobId="v1_omni-1"');
    expect(getVideoJob(dir, 'v1_omni-1')?.status).toBe('pending');

    // O download que cai depois do ACTIVE também não perde o vídeo pago.
    const download = fakeDeps([
      { json: omniInteraction([{ type: 'video', uri: 'files/flaky2' }], { id: 'v1_omni-2' }) },
      { json: { state: 'ACTIVE' } },
      { status: 500, json: { error: { message: 'backend error' } } },
    ]);
    await expect(
      generateVideo({ prompt: 'x', model: 'omni', baseDir: dir }, download.deps),
    ).rejects.toBeInstanceOf(MediaJobInterruptedError);
    expect(getVideoJob(dir, 'v1_omni-2')?.status).toBe('pending');

    // Arquivo que não existe mais (404) é definitivo: retomar não adiantaria.
    const gone = fakeDeps([
      { json: omniInteraction([{ type: 'video', uri: 'files/gone1' }], { id: 'v1_omni-3' }) },
      { status: 404, json: { error: { code: 404, message: 'File not found.' } } },
    ]);
    await expect(generateVideo({ prompt: 'x', model: 'omni', baseDir: dir }, gone.deps)).rejects.toThrow(
      'O arquivo do vídeo não existe mais na Files API do Google (HTTP 404); gere de novo. ' +
        'Resposta do serviço: File not found.',
    );
    expect(getVideoJob(dir, 'v1_omni-3')?.status).toBe('failed');
  });

  it('revisão #145 (P2): o job guarda resolução e usage; retomar só com o id cobra o que foi gerado', async () => {
    const generate = fakeDeps([
      {
        json: omniInteraction([{ type: 'video', uri: 'files/later1' }], {
          id: 'v1_omni-4',
          usage: LIVE_USAGE,
        }),
      },
      { status: 503, json: { error: { message: 'unavailable' } } },
    ]);
    await expect(
      generateVideo({ prompt: 'x', model: 'omni', resolution: '360p', baseDir: dir }, generate.deps),
    ).rejects.toBeInstanceOf(MediaJobInterruptedError);
    expect(getVideoJob(dir, 'v1_omni-4')).toMatchObject({
      resolution: '360p',
      usage: { inputTokens: 22, videoTokens: 19310, textTokens: 304 },
    });

    // Retomada como a mensagem manda: só o recoverJobId, sem resolução.
    const recover = fakeDeps([{ json: { state: 'ACTIVE' } }, { body: fakeMp4(10) }]);
    const result = await generateVideo(
      { prompt: '', recoverJobId: 'v1_omni-4', outPath: 'later.mp4', baseDir: dir },
      recover.deps,
    );
    // Pelos tokens salvos, não pelos $0.10/s do 720p padrão ($1.00).
    expect(result.estimatedCostUsd).toBe(0.3407);
    expect(getVideoJob(dir, 'v1_omni-4')?.status).toBe('completed');
  });

  it('revisão #145 (P2): sem usage, a retomada usa a resolução salva; valor estranho no arquivo é ignorado', async () => {
    saveVideoJob(dir, {
      jobId: 'v1_saved360',
      provider: 'google-video',
      pollTarget: 'files/s360',
      model: 'gemini-omni-1.1-flash',
      prompt: 'x',
      startedAt: 1,
      status: 'pending',
      resolution: '360p',
    });
    const ok = fakeDeps([{ json: { state: 'ACTIVE' } }, { body: fakeMp4(10) }]);
    const cheap = await generateVideo({ prompt: '', recoverJobId: 'v1_saved360', baseDir: dir }, ok.deps);
    expect(cheap.estimatedCostUsd).toBe(0.3);

    saveVideoJob(dir, {
      jobId: 'v1_tampered',
      provider: 'google-video',
      pollTarget: 'files/tamp',
      model: 'gemini-omni-1.1-flash',
      prompt: 'x',
      startedAt: 2,
      status: 'pending',
      resolution: '8k',
      usage: { inputTokens: -1, videoTokens: 1, textTokens: 0 },
    });
    const tampered = fakeDeps([{ json: { state: 'ACTIVE' } }, { body: fakeMp4(10) }]);
    const fallback = await generateVideo(
      { prompt: '', recoverJobId: 'v1_tampered', baseDir: dir },
      tampered.deps,
    );
    // Nem 8k nem usage negativo: tabela do 720p padrão × 10 s.
    expect(fallback.estimatedCostUsd).toBe(1);
  });

  it('revisão #145 (P2): Replicate guarda resolução e duração e a retomada cobra por elas', async () => {
    const create = fakeDeps([
      { json: { id: 'pred-hd', status: 'starting' } },
      { json: { id: 'pred-hd', status: 'processing' } },
    ]);
    create.deps.sleep = async () => {
      throw new Error('para o teste depois do 1º poll');
    };
    await generateVideo(
      { prompt: 'x', model: 'bytedance/seedance-2.0', resolution: '1080p', durationSeconds: 10, baseDir: dir },
      create.deps,
    ).catch(() => undefined);
    expect(getVideoJob(dir, 'pred-hd')).toMatchObject({ resolution: '1080p', durationSeconds: 10 });

    const recover = fakeDeps([
      { json: { id: 'pred-hd', status: 'succeeded', output: 'https://replicate.delivery/hd.mp4' } },
      { body: Buffer.from('mp4') },
    ]);
    const result = await generateVideo(
      { prompt: '', provider: 'replicate-video', recoverJobId: 'pred-hd', baseDir: dir },
      recover.deps,
    );
    // 10 s × $0.45/s em 1080p, não 5 s × $0.18/s do padrão.
    expect(result.estimatedCostUsd).toBe(4.5);
  });

  it('recoverJobId baixa o arquivo já gerado, sem gerar (e pagar) de novo', async () => {
    saveVideoJob(dir, {
      jobId: 'v1_saved',
      provider: 'google-video',
      pollTarget: 'files/saved7',
      model: 'gemini-omni-1.1-flash',
      prompt: 'x',
      startedAt: 1,
      status: 'pending',
    });
    const mp4 = fakeMp4(10);
    const { deps, calls } = fakeDeps([{ json: { state: 'ACTIVE' } }, { body: mp4 }]);
    const result = await generateVideo(
      { prompt: '', recoverJobId: 'v1_saved', outPath: 'back.mp4', baseDir: dir },
      deps,
    );
    expect(calls.map((c) => c.url)).toEqual([
      `${GEMINI}/files/saved7`,
      `${GEMINI}/files/saved7:download?alt=media`,
    ]);
    expect(fs.readFileSync(result.path)).toEqual(mp4);
    expect(result.estimatedCostUsd).toBe(1);
    expect(getVideoJob(dir, 'v1_saved')?.status).toBe('completed');
  });

  it('a espera de 5 min do fetch vira frase do que fazer', async () => {
    const { deps } = fakeDeps([]);
    deps.fetchFn = (async () => {
      throw new TypeError('fetch failed', { cause: { code: 'UND_ERR_HEADERS_TIMEOUT' } });
    }) as typeof fetch;
    await expect(
      generateVideo({ prompt: 'x', model: 'omni', resolution: '4k', baseDir: dir }, deps),
    ).rejects.toThrow('O Google não terminou o vídeo em 5 minutos');
  });
});
describe('F-1599: Grok Imagine (xAI) pelo motor', () => {
  const XAI = 'https://api.x.ai/v1';
  const VIDEO_URL = 'https://vidgen.x.ai/xai-vidgen-bucket/xai-video-req-1.mp4';
  const REQUEST_ID = 'a3d1008e-4544-40d4-d075-11527e794e4a';
  const xaiOnly = (deps: MediaDeps): MediaDeps => ({
    ...deps,
    getKey: (def) => (def.envVar === 'XAI_API_KEY' ? 'xai-test-key' : undefined),
  });

  it('vídeo: envia o pedido, faz poll até done, baixa de vidgen.x.ai sem a chave e cobra o que a xAI informou', async () => {
    const mp4 = Buffer.from('xai-mp4-bytes');
    const { deps, calls } = fakeDeps([
      { json: { request_id: REQUEST_ID } },
      { json: { status: 'pending', progress: 40 } },
      {
        json: {
          status: 'done',
          video: { url: VIDEO_URL, duration: 6, respect_moderation: true },
          model: 'grok-imagine-video-1.5',
          usage: { cost_in_usd_ticks: 8_400_000_000 },
        },
      },
      { body: mp4 },
    ]);
    const res = await generateVideo(
      {
        prompt: 'drone sobre a praia',
        model: 'grok',
        durationSeconds: 6,
        resolution: '720p',
        aspectRatio: '9:16',
        outPath: 'grok.mp4',
        baseDir: dir,
      },
      xaiOnly(deps),
    );
    expect(calls[0]?.url).toBe(`${XAI}/videos/generations`);
    expect(calls[0]?.init?.method).toBe('POST');
    expect(new Headers(calls[0]?.init?.headers).get('authorization')).toBe('Bearer xai-test-key');
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      model: 'grok-imagine-video-1.5',
      prompt: 'drone sobre a praia',
      duration: 6,
      aspect_ratio: '9:16',
      resolution: '720p',
    });
    expect(calls[1]?.url).toBe(`${XAI}/videos/${REQUEST_ID}`);
    expect(calls[2]?.url).toBe(`${XAI}/videos/${REQUEST_ID}`);
    expect(calls[3]?.url).toBe(VIDEO_URL);
    // A chave nunca vai para o host do vídeo.
    expect(new Headers(calls[3]?.init?.headers).get('authorization')).toBeNull();
    expect(fs.readFileSync(path.join(dir, 'grok.mp4')).toString()).toBe('xai-mp4-bytes');
    expect(res).toMatchObject({
      provider: 'xai-video',
      model: 'grok-imagine-video-1.5',
      kind: 'video',
      estimatedCostUsd: 0.84,
      jobId: REQUEST_ID,
    });
    expect(getVideoJob(dir, REQUEST_ID)).toMatchObject({ provider: 'xai-video', status: 'completed' });
  });

  it('vídeo sem usage cobra a tabela; sem duração nem resolução usa o padrão do modelo (8 s, 720p)', async () => {
    const { deps, calls } = fakeDeps([
      { json: { request_id: REQUEST_ID } },
      { json: { status: 'done', video: { url: VIDEO_URL, respect_moderation: true } } },
      { body: Buffer.from('mp4') },
    ]);
    const res = await generateVideo({ prompt: 'x', provider: 'xai-video', baseDir: dir }, xaiOnly(deps));
    expect(JSON.parse(String(calls[0]?.init?.body))).toMatchObject({ duration: 8, resolution: '720p' });
    // 8 s × US$ 0,14/s (720p no grok-imagine-video-1.5).
    expect(res.estimatedCostUsd).toBe(1.12);
  });

  it('vídeo com imagem inicial manda data URL e não manda proporção', async () => {
    fs.writeFileSync(path.join(dir, 'start.png'), Buffer.from('png-start'));
    const { deps, calls } = fakeDeps([
      { json: { request_id: REQUEST_ID } },
      { json: { status: 'done', video: { url: VIDEO_URL, duration: 5, respect_moderation: true } } },
      { body: Buffer.from('mp4') },
    ]);
    await generateVideo(
      {
        prompt: 'anime',
        model: 'grok-video-lite',
        durationSeconds: 5,
        aspectRatio: '16:9',
        imagePath: 'start.png',
        baseDir: dir,
      },
      xaiOnly(deps),
    );
    const body = JSON.parse(String(calls[0]?.init?.body)) as Record<string, unknown>;
    expect(body.model).toBe('grok-imagine-video-1.5-lite');
    expect(body.image).toEqual({ url: `data:image/png;base64,${Buffer.from('png-start').toString('base64')}` });
    expect(body).not.toHaveProperty('aspect_ratio');
  });

  it('o que o modelo recusa para antes de qualquer chamada paga', async () => {
    const { deps, calls } = fakeDeps([]);
    fs.writeFileSync(path.join(dir, 'ref.png'), Buffer.from('ref'));
    await expect(
      generateVideo(
        { prompt: 'x', model: 'grok-video-lite', referenceImagePaths: ['ref.png'], baseDir: dir },
        xaiOnly(deps),
      ),
    ).rejects.toThrow('grok-imagine-video-1.5-lite não usa imagens de referência');
    await expect(
      generateVideo({ prompt: 'x', model: 'grok', durationSeconds: 16, baseDir: dir }, xaiOnly(deps)),
    ).rejects.toThrow('grok-imagine-video-1.5 aceita 1, 2, 3');
    await expect(
      generateVideo({ prompt: 'x', model: 'grok-imagine-video', resolution: '1080p', baseDir: dir }, xaiOnly(deps)),
    ).rejects.toThrow('grok-imagine-video aceita resolução 480p, 720p (pedido: 1080p).');
    expect(calls).toHaveLength(0);
  });

  it('falha no serviço vira a frase do que fazer e o job fica como falho', async () => {
    const { deps } = fakeDeps([
      { json: { request_id: REQUEST_ID } },
      { json: { status: 'failed', error: { code: 'failed_precondition', message: 'resolution not supported' } } },
    ]);
    await expect(
      generateVideo({ prompt: 'x', provider: 'xai-video', baseDir: dir }, xaiOnly(deps)),
    ).rejects.toThrow(
      'O modelo não faz isso com essas opções (resolução ou modo). Troque o modelo ou as opções. ' +
        'Resposta do serviço: resolution not supported',
    );
    expect(getVideoJob(dir, REQUEST_ID)?.status).toBe('failed');
  });

  it('URL do vídeo fora de vidgen.x.ai não é baixada', async () => {
    const { deps, calls } = fakeDeps([
      { json: { request_id: REQUEST_ID } },
      { json: { status: 'done', video: { url: 'https://api.x.ai/v1/files/x.mp4', respect_moderation: true } } },
    ]);
    await expect(
      generateVideo({ prompt: 'x', provider: 'xai-video', baseDir: dir }, xaiOnly(deps)),
    ).rejects.toThrow('xai-video: domínio não permitido para download');
    expect(calls).toHaveLength(2);
  });

  it('estouro de tempo devolve recoverJobId; a retomada só faz poll, sem gerar de novo', async () => {
    const pending = Array.from({ length: 120 }, () => ({ json: { status: 'pending' } }));
    const first = fakeDeps([{ json: { request_id: REQUEST_ID } }, ...pending]);
    const err = await generateVideo(
      { prompt: 'x', provider: 'xai-video', outPath: 'late.mp4', baseDir: dir },
      xaiOnly(first.deps),
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MediaJobTimeoutError);
    expect((err as MediaJobTimeoutError).jobId).toBe(REQUEST_ID);
    expect((err as MediaJobTimeoutError).recoverable).toBe(true);
    expect(first.calls).toHaveLength(121);
    expect(getVideoJob(dir, REQUEST_ID)?.status).toBe('pending');

    const resumed = fakeDeps([
      { json: { status: 'done', video: { url: VIDEO_URL, duration: 8, respect_moderation: true } } },
      { body: Buffer.from('late-mp4') },
    ]);
    const res = await generateVideo({ prompt: '', recoverJobId: REQUEST_ID, baseDir: dir }, xaiOnly(resumed.deps));
    expect(resumed.calls.map((c) => c.url)).toEqual([`${XAI}/videos/${REQUEST_ID}`, VIDEO_URL]);
    expect(fs.readFileSync(path.join(dir, 'late.mp4')).toString()).toBe('late-mp4');
    expect(res).toMatchObject({ provider: 'xai-video', jobId: REQUEST_ID });
    expect(getVideoJob(dir, REQUEST_ID)?.status).toBe('completed');
  });

  it('chave recusada (HTTP 400 "Incorrect API key") diz para trocar a chave, não "pedido inválido"', async () => {
    // Corpo visto ao vivo com chave falsa em 19/10/2026.
    const { deps } = fakeDeps([
      {
        status: 400,
        json: {
          code: 'invalid-argument',
          error: 'Incorrect API key provided. You can obtain an API key from https://console.x.ai.',
        },
      },
    ]);
    const err = await generateVideo(
      { prompt: 'x', provider: 'xai-video', baseDir: dir },
      xaiOnly(deps),
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MediaProviderHttpError);
    expect((err as MediaProviderHttpError).kind).toBe('key');
    expect((err as Error).message).toContain('xAI recusou a chave (HTTP 400)');
  });

  it('imagem: gera em base64, grava .jpg pelo mime_type e cobra o que a xAI informou', async () => {
    const { deps, calls } = fakeDeps([
      {
        json: {
          data: [{ b64_json: Buffer.from('jpeg').toString('base64'), mime_type: 'image/jpeg' }],
          usage: { cost_in_usd_ticks: 400_000_000 },
        },
      },
    ]);
    const res = await generateImage(
      { prompt: 'um farol', model: 'grok', aspectRatio: '1:1', baseDir: dir },
      xaiOnly(deps),
    );
    expect(calls[0]?.url).toBe(`${XAI}/images/generations`);
    expect(new Headers(calls[0]?.init?.headers).get('authorization')).toBe('Bearer xai-test-key');
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      model: 'grok-imagine-image-2.0',
      prompt: 'um farol',
      response_format: 'b64_json',
      aspect_ratio: '1:1',
    });
    expect(res.path).toBe(path.join(dir, 'generated-1000.jpg'));
    expect(fs.readFileSync(res.path).toString()).toBe('jpeg');
    expect(res).toMatchObject({ provider: 'xai-image', model: 'grok-imagine-image-2.0', estimatedCostUsd: 0.04 });
  });

  it('imagem com imagePath edita em /images/edits; PNG sai .png; sem usage, preço de lista do tamanho', async () => {
    fs.writeFileSync(path.join(dir, 'foto.png'), Buffer.from('foto'));
    const { deps, calls } = fakeDeps([{ json: { data: [{ b64_json: 'cG5n', mime_type: 'image/png' }] } }]);
    const res = await generateImage(
      { prompt: 'em lápis', provider: 'xai-image', imagePath: 'foto.png', size: '2K', baseDir: dir },
      xaiOnly(deps),
    );
    expect(calls[0]?.url).toBe(`${XAI}/images/edits`);
    expect(JSON.parse(String(calls[0]?.init?.body))).toMatchObject({
      resolution: '2k',
      image: { url: `data:image/png;base64,${Buffer.from('foto').toString('base64')}` },
    });
    expect(res.path).toBe(path.join(dir, 'generated-1000.png'));
    expect(res.estimatedCostUsd).toBe(0.06);
  });
});
