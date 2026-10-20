import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { generateImage, generateVideo, type MediaDeps } from './media-generation';
import { getVideoJob } from './media-video-jobs';
import { MediaProviderHttpError, mediaHttpErrorKind } from './media-errors';
import { findMediaProvider, resolveMediaProvider } from './media-providers';
import {
  higgsfieldAuthHeader,
  higgsfieldImageBody,
  higgsfieldImagePlan,
  higgsfieldStatusUrl,
  higgsfieldVideoBody,
  higgsfieldVideoPlan,
  readHiggsfieldStatus,
} from './higgsfield';

const API = 'https://api.higgsfield.ai';
const REQUEST_ID = 'd7e6c0f3-6699-4f6a-9b1c-2f1e0a9b8c7d';
const CDN = 'https://d28lhcrx5qdowv.cloudfront.net/outputs/clip.mp4';
const KEY = 'kid_123:secret_456';

let dir: string;

beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-hf-')));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

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
      if (next.body) return new Response(new Uint8Array(next.body), { status });
      return new Response(JSON.stringify(next.json ?? {}), {
        status,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch,
    resolveHostname: async () => ['93.184.216.34'],
    // Só a Higgsfield tem chave: nenhum outro serviço é escolhido sem querer.
    getKey: (def) => (def.envVar === 'HIGGSFIELD_API_KEY' ? KEY : undefined),
    sleep: async () => {},
    now: () => 1_000,
  };
  return { deps, calls };
}

const header = (call: { init?: RequestInit } | undefined, name: string) =>
  new Headers(call?.init?.headers).get(name);
const json = (call: { init?: RequestInit } | undefined) => JSON.parse(String(call?.init?.body));

describe('F-1613: contrato puro da Higgsfield', () => {
  it('chave ID:SEGREDO vira Authorization: Key, com ou sem o prefixo; chave de uma parte é recusada', () => {
    expect(higgsfieldAuthHeader(KEY)).toBe(`Key ${KEY}`);
    expect(higgsfieldAuthHeader(`Key ${KEY}  `)).toBe(`Key ${KEY}`);
    expect(() => higgsfieldAuthHeader('so-uma-parte')).toThrow(/ID:SEGREDO/u);
  });

  it('a URL de status é montada só a partir de um UUID', () => {
    expect(higgsfieldStatusUrl(REQUEST_ID)).toBe(`${API}/requests/${REQUEST_ID}/status`);
    expect(() => higgsfieldStatusUrl('../../files/generate-upload-url')).toThrow(/inválido/u);
  });

  it('lê os estados: pendente, concluído, moderado, falhou, cancelado', () => {
    expect(readHiggsfieldStatus({ status: 'queued' }, 'video')).toEqual({ state: 'pending' });
    expect(readHiggsfieldStatus({ status: 'in_progress' }, 'image')).toEqual({ state: 'pending' });
    expect(readHiggsfieldStatus({ status: 'completed', video: { url: CDN } }, 'video')).toEqual({
      state: 'done',
      url: CDN,
    });
    expect(readHiggsfieldStatus({ status: 'completed', images: [{ url: 'https://cdn.higgsfield.ai/a.jpg' }] }, 'image'))
      .toMatchObject({ state: 'done' });
    expect(readHiggsfieldStatus({ status: 'completed' }, 'video')).toMatchObject({ state: 'failed' });
    expect(readHiggsfieldStatus({ status: 'nsfw' }, 'video')).toMatchObject({
      state: 'failed',
      problem: expect.stringMatching(/não é cobrado/u),
    });
    expect(readHiggsfieldStatus({ status: 'failed', error: 'boom' }, 'video')).toMatchObject({
      problem: expect.stringContaining('(boom)'),
    });
    expect(readHiggsfieldStatus({ status: 'canceled' }, 'video')).toMatchObject({ state: 'failed' });
  });

  it('o fluxo sai do pedido: texto, imagem ou referência — nunca quadro com referência', () => {
    const none = { hasImage: false, hasEndImage: false, referenceImages: 0, referenceVideos: 0 };
    expect(higgsfieldVideoPlan('higgsfield/seedance-2.5', none).endpoint).toBe(
      'bytedance/seedance-2.5/text-to-video',
    );
    expect(higgsfieldVideoPlan('higgsfield/seedance-2.5', { ...none, hasImage: true }).endpoint).toBe(
      'bytedance/seedance-2.5/image-to-video',
    );
    expect(higgsfieldVideoPlan('higgsfield/seedance-2.5', { ...none, referenceVideos: 1 }).endpoint).toBe(
      'bytedance/seedance-2.5/reference-to-video',
    );
    expect(() =>
      higgsfieldVideoPlan('higgsfield/seedance-2.5', { ...none, hasImage: true, referenceImages: 1 }),
    ).toThrow(/não combina/u);
    expect(() => higgsfieldVideoPlan('higgsfield/kling-3.0-pro', { ...none, referenceImages: 1 })).toThrow(
      /não recebe referências/u,
    );
  });

  it('corpo por modelo: proporção só onde o schema aceita, resolução só onde existe', () => {
    const req = { prompt: ' praia ', durationSeconds: 8, resolution: '1080p', aspectRatio: '9:16' };
    expect(higgsfieldVideoBody('higgsfield/seedance-2.5', 'text', req, { images: [], videos: [] })).toEqual({
      generate_audio: true,
      prompt: 'praia',
      duration: 8,
      resolution: '1080p',
      aspect_ratio: '9:16',
    });
    // Seedance imagem→vídeo não tem aspect_ratio; H3 tem, e não tem resolução.
    const i2v = higgsfieldVideoBody('higgsfield/seedance-2.5', 'image', req, {
      image: 'https://cdn/a.png',
      endImage: 'https://cdn/b.png',
      images: [],
      videos: [],
    });
    expect(i2v).not.toHaveProperty('aspect_ratio');
    expect(i2v).toMatchObject({ image_url: 'https://cdn/a.png', end_image_url: 'https://cdn/b.png' });
    const h3 = higgsfieldVideoBody('higgsfield/minimax-h3', 'image', req, { image: 'https://cdn/a.png', images: [], videos: [] });
    expect(h3).toMatchObject({ aspect_ratio: '9:16', aigc_watermark: false });
    expect(h3).not.toHaveProperty('resolution');
    const kling = higgsfieldVideoBody('higgsfield/kling-3.0-pro', 'image', req, {
      image: 'https://cdn/a.png',
      endImage: 'https://cdn/b.png',
      images: [],
      videos: [],
    });
    expect(kling).toMatchObject({ sound: 'on', last_image_url: 'https://cdn/b.png' });
    const ref = higgsfieldVideoBody('higgsfield/wan-3.0', 'reference', req, {
      images: ['https://cdn/r.png'],
      videos: ['https://cdn/v.mp4'],
    });
    expect(ref).toMatchObject({ image_urls: ['https://cdn/r.png'], video_urls: ['https://cdn/v.mp4'] });
  });

  it('imagem: texto, edição com image_url ou image_urls, e proporção conferida', () => {
    expect(higgsfieldImagePlan('higgsfield/soul-2', 0)).toEqual({ endpoint: 'higgsfield-ai/soul/v2/standard' });
    expect(() => higgsfieldImagePlan('higgsfield/soul-2', 1)).toThrow(/só a partir do texto/u);
    expect(higgsfieldImagePlan('higgsfield/qwen-image-3', 2)).toEqual({
      endpoint: 'alibaba/qwen-image-3/edit',
      field: 'image_urls',
    });
    expect(() => higgsfieldImagePlan('higgsfield/qwen-image-3', 4)).toThrow(/até 3/u);
    expect(higgsfieldImageBody('higgsfield/ideogram-4', { prompt: 'logo', aspectRatio: '1:1' }, 'image_url', ['u'])).toEqual({
      prompt: 'logo',
      aspect_ratio: '1:1',
      image_url: 'u',
    });
    expect(() => higgsfieldImageBody('higgsfield/recraft-4.1', { prompt: 'x', aspectRatio: '21:9' }, undefined, [])).toThrow(
      /aceita proporção/u,
    );
  });

  it('403 por falta de crédito é cobrança, não chave; 423 é indisponível', () => {
    expect(mediaHttpErrorKind(403, undefined, 'Not enough credits')).toBe('billing');
    expect(mediaHttpErrorKind(403, undefined, 'Forbidden')).toBe('key');
    expect(mediaHttpErrorKind(423)).toBe('unavailable');
  });

  it('sem preço de tabela, nunca é escolhida sozinha à frente de quem tem preço', () => {
    const keyed = (ids: string[]) => (def: { id: string }) => ids.includes(def.id);
    expect(resolveMediaProvider('video', undefined, keyed(['higgsfield-video', 'replicate-video'])).id).toBe(
      'replicate-video',
    );
    expect(findMediaProvider('higgsfield-video')?.defaultModel).toBe('higgsfield/seedance-2.5');
  });
});

describe('F-1613: Higgsfield pelo motor', () => {
  it('vídeo com vídeo de exemplo: sobe as entradas sem a chave, cota, envia, faz poll e baixa do CDN', async () => {
    fs.mkdirSync(path.join(dir, 'media/referencias'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'media/referencias/rosto.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    fs.writeFileSync(path.join(dir, 'media/referencias/demo.mp4'), Buffer.from('mp4-demo'));
    const upload = (n: number, type: string) => ({
      json: {
        public_url: `https://cdn.higgsfield.ai/input/${n}`,
        upload_url: `https://uploads.s3.amazonaws.com/presigned-${n}`,
        content_type: type,
        upload_headers: { 'Content-Type': type, 'x-amz-tagging': 'retention=temporary' },
      },
    });
    const { deps, calls } = fakeDeps([
      upload(1, 'image/png'),
      { status: 200, json: {} },
      upload(2, 'video/mp4'),
      { status: 200, json: {} },
      { json: { credits: '18.000', usd: '1.125' } },
      { json: { status: 'queued', request_id: REQUEST_ID, status_url: 'https://evil.example/steal' } },
      { json: { status: 'in_progress', request_id: REQUEST_ID } },
      { json: { status: 'completed', request_id: REQUEST_ID, video: { url: CDN } } },
      { body: Buffer.from('mp4-out') },
    ]);
    const res = await generateVideo(
      {
        prompt: 'a apresentadora com o movimento de [Video1]',
        model: 'higgsfield/seedance-2.5',
        durationSeconds: 10,
        resolution: '1080p',
        aspectRatio: '9:16',
        referenceImagePaths: ['media/referencias/rosto.png'],
        referenceVideoPaths: ['media/referencias/demo.mp4'],
        outPath: 'clip.mp4',
        baseDir: dir,
      },
      deps,
    );
    expect(calls[0]?.url).toBe(`${API}/files/generate-upload-url`);
    expect(header(calls[0], 'authorization')).toBe(`Key ${KEY}`);
    // O storage pré-assinado nunca recebe a chave da Higgsfield.
    expect(calls[1]?.init?.method).toBe('PUT');
    expect(header(calls[1], 'authorization')).toBeNull();
    expect(header(calls[1], 'x-amz-tagging')).toBe('retention=temporary');
    expect(json(calls[2])).toEqual({ content_type: 'video/mp4' });
    expect(calls[4]?.url).toBe(`${API}/estimate/bytedance/seedance-2.5/reference-to-video`);
    expect(calls[5]?.url).toBe(`${API}/bytedance/seedance-2.5/reference-to-video`);
    expect(header(calls[5], 'idempotency-key')).toMatch(/^[0-9a-f-]{36}$/u);
    expect(json(calls[5])).toEqual({
      generate_audio: true,
      prompt: 'a apresentadora com o movimento de [Video1]',
      duration: 10,
      resolution: '1080p',
      aspect_ratio: '9:16',
      image_urls: ['https://cdn.higgsfield.ai/input/1'],
      video_urls: ['https://cdn.higgsfield.ai/input/2'],
    });
    // O status_url da resposta é ignorado: a chave só vai para a URL montada.
    expect(calls[6]?.url).toBe(`${API}/requests/${REQUEST_ID}/status`);
    expect(calls[8]?.url).toBe(CDN);
    expect(header(calls[8], 'authorization')).toBeNull();
    expect(fs.readFileSync(path.join(dir, 'clip.mp4')).toString()).toBe('mp4-out');
    expect(res).toMatchObject({
      provider: 'higgsfield-video',
      model: 'higgsfield/seedance-2.5',
      estimatedCostUsd: 1.125,
      jobId: REQUEST_ID,
    });
    expect(getVideoJob(dir, REQUEST_ID)).toMatchObject({
      provider: 'higgsfield-video',
      status: 'completed',
      quotedCostUsd: 1.125,
    });
  });

  it('moderação encerra o job sem retomada; modelo sem vídeo de exemplo recusa antes de pagar', async () => {
    const { deps } = fakeDeps([
      { json: { usd: '0.4' } },
      { json: { status: 'queued', request_id: REQUEST_ID } },
      { json: { status: 'nsfw', request_id: REQUEST_ID } },
    ]);
    await expect(
      generateVideo({ prompt: 'x', model: 'higgsfield/kling-3.0-pro', baseDir: dir }, deps),
    ).rejects.toThrow(/moderação/u);
    expect(getVideoJob(dir, REQUEST_ID)).toMatchObject({ status: 'failed' });

    fs.writeFileSync(path.join(dir, 'demo.mp4'), Buffer.from('x'));
    const { deps: none, calls } = fakeDeps([]);
    await expect(
      generateVideo(
        { prompt: 'x', model: 'higgsfield/kling-3.0-pro', referenceVideoPaths: ['demo.mp4'], baseDir: dir },
        none,
      ),
    ).rejects.toThrow(/não recebe vídeo de exemplo/u);
    expect(calls).toHaveLength(0);
  });

  it('imagem: edita com o arquivo do projeto e grava com a extensão do que veio', async () => {
    fs.writeFileSync(path.join(dir, 'logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const webp = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8 ')]);
    const { deps, calls } = fakeDeps([
      {
        json: {
          public_url: 'https://cdn.higgsfield.ai/input/logo',
          upload_url: 'https://uploads.s3.amazonaws.com/p',
          upload_headers: { 'Content-Type': 'image/png' },
        },
      },
      { status: 200, json: {} },
      { json: { usd: '0.03' } },
      { json: { status: 'queued', request_id: REQUEST_ID } },
      { json: { status: 'completed', images: [{ url: 'https://cdn.higgsfield.ai/out/1' }] } },
      { body: webp },
    ]);
    const res = await generateImage(
      {
        prompt: 'o logo em neon',
        model: 'higgsfield/ideogram-4',
        aspectRatio: '16:9',
        imagePath: 'logo.png',
        outPath: 'neon.png',
        baseDir: dir,
      },
      deps,
    );
    expect(calls[3]?.url).toBe(`${API}/ideogram/v4.0`);
    expect(json(calls[3])).toEqual({
      prompt: 'o logo em neon',
      aspect_ratio: '16:9',
      image_url: 'https://cdn.higgsfield.ai/input/logo',
    });
    expect(res.path.endsWith('neon.webp')).toBe(true);
    expect(res.estimatedCostUsd).toBe(0.03);
  });

  it('crédito insuficiente vira erro de cobrança com a frase certa', async () => {
    const { deps } = fakeDeps([
      { json: { usd: '0.2' } },
      { status: 403, json: { detail: 'Not enough credits' } },
    ]);
    const err = await generateImage({ prompt: 'x', model: 'higgsfield/soul-2', baseDir: dir }, deps).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(MediaProviderHttpError);
    expect((err as MediaProviderHttpError).kind).toBe('billing');
    expect((err as Error).message).toMatch(/^Higgsfield recusou por falta de saldo/u);
  });
});
