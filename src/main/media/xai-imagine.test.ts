import { describe, expect, it } from 'vitest';
import {
  extractXaiImage,
  readXaiVideoPoll,
  xaiCostUsd,
  xaiImageOutputPath,
  xaiImageRequest,
  xaiRequestId,
  xaiVideoInputProblem,
  xaiVideoPollUrl,
  xaiVideoRequest,
} from './xai-imagine';

const PNG = { mimeType: 'image/png', data: 'cG5n' };
const JPG = { mimeType: 'image/jpeg', data: 'anBn' };

describe('F-1599: pedido de vídeo do Grok Imagine', () => {
  it('texto → vídeo sai igual ao exemplo REST da documentação', () => {
    // docs.x.ai/developers/model-capabilities/video/generation, "Quick Start".
    expect(
      xaiVideoRequest(
        {
          prompt: 'A glowing crystal-powered rocket launching from the red dunes of Mars',
          durationSeconds: 10,
          aspectRatio: '16:9',
          resolution: '720p',
        },
        'grok-imagine-video-1.5',
      ),
    ).toEqual({
      model: 'grok-imagine-video-1.5',
      prompt: 'A glowing crystal-powered rocket launching from the red dunes of Mars',
      duration: 10,
      aspect_ratio: '16:9',
      resolution: '720p',
    });
  });

  it('imagem inicial vai como data URL e a proporção não vai (a saída segue a imagem)', () => {
    const body = xaiVideoRequest(
      { prompt: 'anime a cena', durationSeconds: 6, aspectRatio: '9:16', resolution: '480p' },
      'grok-imagine-video-1.5-lite',
      { start: PNG },
    );
    expect(body).toEqual({
      model: 'grok-imagine-video-1.5-lite',
      prompt: 'anime a cena',
      duration: 6,
      resolution: '480p',
      image: { url: 'data:image/png;base64,cG5n' },
    });
  });

  it('último quadro e referências usam os campos da documentação', () => {
    const body = xaiVideoRequest({ prompt: 'a pessoa de <IMAGE_1>', aspectRatio: '1:1' }, 'grok-imagine-video-1.5', {
      start: PNG,
      end: JPG,
      references: [JPG, PNG],
    });
    expect(body).toMatchObject({
      image: { url: 'data:image/png;base64,cG5n' },
      last_frame: { url: 'data:image/jpeg;base64,anBn' },
      reference_images: [{ url: 'data:image/jpeg;base64,anBn' }, { url: 'data:image/png;base64,cG5n' }],
    });
    expect(body).not.toHaveProperty('aspect_ratio');
    // Sem imagem inicial (só referências), a proporção vai.
    expect(
      xaiVideoRequest({ prompt: 'x', aspectRatio: '21:9' }, 'grok-imagine-video-1.5', { references: [PNG] }),
    ).toMatchObject({ aspect_ratio: '21:9' });
  });

  it('sem texto e sem imagem é recusado antes de chamar a xAI', () => {
    expect(() => xaiVideoRequest({ prompt: '  ' }, 'grok-imagine-video-1.5')).toThrow(
      'Vídeo do Grok sem imagem precisa de um texto (prompt).',
    );
    // Com imagem o texto é opcional na xAI.
    expect(xaiVideoRequest({ prompt: '' }, 'grok-imagine-video-1.5', { start: PNG })).not.toHaveProperty('prompt');
  });

  it('o que cada modelo não aceita é dito antes de pagar', () => {
    const base = { hasImage: false, hasEndImage: false, referenceCount: 0 };
    expect(xaiVideoInputProblem('grok-imagine-video-1.5', { ...base, hasEndImage: true })).toBeNull();
    expect(xaiVideoInputProblem('grok-imagine-video', { ...base, hasEndImage: true })).toBe(
      'grok-imagine-video não fixa o último quadro: use grok-imagine-video-1.5 ou tire a imagem final (endImagePath).',
    );
    expect(xaiVideoInputProblem('grok-imagine-video-1.5-lite', { ...base, referenceCount: 1 })).toContain(
      'não usa imagens de referência',
    );
    expect(xaiVideoInputProblem('grok-imagine-video-1.5', { ...base, referenceCount: 15 })).toBe(
      'grok-imagine-video-1.5 aceita até 14 imagens de referência (pedido: 15).',
    );
    expect(xaiVideoInputProblem('grok-imagine-video', { ...base, referenceCount: 8 })).toContain('até 7');
    expect(xaiVideoInputProblem('grok-imagine-video', { ...base, hasImage: true, referenceCount: 2 })).toContain(
      'não junta imagem inicial com referências',
    );
    expect(xaiVideoInputProblem('grok-imagine-video-1.5', { ...base, hasImage: true, referenceCount: 2 })).toBeNull();
    expect(
      xaiVideoInputProblem('grok-imagine-video-1.5', { ...base, referenceCount: 1, resolution: '1080p' }),
    ).toBe('grok-imagine-video-1.5 com referências ou último quadro vai até 720p (pedido: 1080p).');
    expect(
      xaiVideoInputProblem('grok-imagine-video', { ...base, referenceCount: 3, durationSeconds: 12 }),
    ).toBe('grok-imagine-video com referências vai até 10 segundos (pedido: 12 s).');
    expect(xaiVideoInputProblem('bytedance/seedance-2.0', { ...base, referenceCount: 40 })).toBeNull();
  });
});

describe('F-1599: resposta do vídeo do Grok Imagine', () => {
  it('lê o request_id do exemplo e recusa id que viraria outro caminho de URL', () => {
    expect(xaiRequestId({ request_id: 'a3d1008e-4544-40d4-d075-11527e794e4a' })).toBe(
      'a3d1008e-4544-40d4-d075-11527e794e4a',
    );
    expect(xaiVideoPollUrl('d97415a1-5796-b7ec-379f-4e6819e08fdf')).toBe(
      'https://api.x.ai/v1/videos/d97415a1-5796-b7ec-379f-4e6819e08fdf',
    );
    expect(() => xaiRequestId({})).toThrow('não devolveu um request_id válido');
    expect(() => xaiVideoPollUrl('../files/abc')).toThrow('request_id válido');
    expect(() => xaiVideoPollUrl('abc?x=1')).toThrow('request_id válido');
  });

  it('done do exemplo da documentação vira URL e duração; usage vira o custo cobrado', () => {
    // docs.x.ai/developers/rest-api-reference/inference/videos, GET /v1/videos/{request_id}.
    expect(
      readXaiVideoPoll({
        status: 'done',
        video: {
          url: 'https://vidgen.x.ai/xai-vidgen-bucket/xai-video-abc.mp4',
          duration: 6,
          respect_moderation: true,
        },
        model: 'grok-imagine-video',
      }),
    ).toEqual({ state: 'done', url: 'https://vidgen.x.ai/xai-vidgen-bucket/xai-video-abc.mp4', durationSeconds: 6 });
    expect(
      readXaiVideoPoll({
        status: 'done',
        video: { url: 'https://vidgen.x.ai/v.mp4', duration: 8, respect_moderation: true },
        usage: { cost_in_usd_ticks: 11_200_000_000 },
      }),
    ).toMatchObject({ costUsd: 1.12 });
  });

  it('pending segue esperando, com o progresso quando vem', () => {
    expect(readXaiVideoPoll({ status: 'pending', progress: 42 })).toEqual({ state: 'pending', progress: 42 });
    expect(readXaiVideoPoll({ status: 'pending' })).toEqual({ state: 'pending' });
  });

  it('failed do exemplo diz o que fazer e traz a frase do serviço', () => {
    const poll = readXaiVideoPoll({
      status: 'failed',
      error: { code: 'invalid_argument', message: 'Prompt cannot be empty. Please provide a prompt.' },
    });
    expect(poll).toEqual({
      state: 'failed',
      problem:
        'A xAI recusou o pedido: parâmetro inválido ou conteúdo barrado pela moderação. Mude o pedido e gere de novo. ' +
        'Resposta do serviço: Prompt cannot be empty. Please provide a prompt.',
    });
    expect(readXaiVideoPoll({ status: 'failed', error: { code: 'service_unavailable', message: '' } })).toEqual({
      state: 'failed',
      problem: 'A geração de vídeo da xAI está sobrecarregada. Tente de novo mais tarde.',
    });
    expect(readXaiVideoPoll({ status: 'expired' })).toMatchObject({ state: 'failed', problem: expect.stringContaining('expirou') });
  });

  it('vídeo barrado na moderação ou sem URL não vira sucesso', () => {
    expect(
      readXaiVideoPoll({ status: 'done', video: { url: '', duration: 8, respect_moderation: false } }),
    ).toMatchObject({ state: 'failed', problem: expect.stringContaining('moderação') });
    expect(readXaiVideoPoll({ status: 'done', video: { duration: 8, respect_moderation: true } })).toMatchObject({
      state: 'failed',
      problem: expect.stringContaining('sem a URL'),
    });
  });

  it('ticks viram dólar (1 USD = 10^10 ticks); valor inválido é ignorado', () => {
    expect(xaiCostUsd({ cost_in_usd_ticks: 200_000_000 })).toBe(0.02);
    expect(xaiCostUsd({ cost_in_usd_ticks: -1 })).toBeUndefined();
    expect(xaiCostUsd({ image_cost: 2_000_000 })).toBeUndefined();
    expect(xaiCostUsd(undefined)).toBeUndefined();
  });
});

describe('F-1599: imagem do Grok Imagine', () => {
  it('revisão #145: o arquivo leva a extensão do formato que a xAI devolveu, também com outPath', () => {
    expect(xaiImageOutputPath('/proj/hero.png', 'jpg')).toBe('/proj/hero.jpg');
    expect(xaiImageOutputPath('/proj/hero.jpg', 'png')).toBe('/proj/hero.png');
    expect(xaiImageOutputPath('/proj/HERO.PNG', 'webp')).toBe('/proj/HERO.webp');
    // Mesmo formato: o nome pedido fica (inclusive .jpeg para JPEG).
    expect(xaiImageOutputPath('/proj/hero.jpeg', 'jpg')).toBe('/proj/hero.jpeg');
    expect(xaiImageOutputPath('/proj/hero.png', 'png')).toBe('/proj/hero.png');
    // Sem extensão de imagem: acrescenta a certa, sem perder o nome.
    expect(xaiImageOutputPath('/proj/capa', 'jpg')).toBe('/proj/capa.jpg');
    expect(xaiImageOutputPath('/proj/capa.v2', 'png')).toBe('/proj/capa.v2.png');
  });

  it('geração pede base64, com proporção e tamanho no vocabulário da xAI', () => {
    expect(
      xaiImageRequest({ prompt: 'Mountain landscape at sunrise', aspectRatio: '16:9', size: '2K' }, 'grok-imagine-image-2.0'),
    ).toEqual({
      endpoint: 'images/generations',
      body: {
        model: 'grok-imagine-image-2.0',
        prompt: 'Mountain landscape at sunrise',
        response_format: 'b64_json',
        aspect_ratio: '16:9',
        resolution: '2k',
      },
    });
  });

  it('com imagem do projeto é edição em /images/edits', () => {
    const { endpoint, body } = xaiImageRequest({ prompt: 'em lápis' }, 'grok-imagine-image-2.0', PNG);
    expect(endpoint).toBe('images/edits');
    expect(body).toEqual({
      model: 'grok-imagine-image-2.0',
      prompt: 'em lápis',
      response_format: 'b64_json',
      image: { url: 'data:image/png;base64,cG5n' },
    });
  });

  it('tamanho e proporção que o modelo recusa param antes de pagar', () => {
    expect(() => xaiImageRequest({ prompt: 'x', size: '1.5K' }, 'grok-imagine-image')).toThrow(
      'grok-imagine-image aceita tamanho 1K, 2K (pedido: 1.5K).',
    );
    expect(() => xaiImageRequest({ prompt: 'x', aspectRatio: 'match_input_image' }, 'grok-imagine-image-2.0')).toThrow(
      'aceita proporção',
    );
  });

  it('lê a imagem em base64, a extensão pelo mime_type e o custo cobrado', () => {
    const out = extractXaiImage({
      data: [{ b64_json: Buffer.from('jpeg-bytes').toString('base64'), mime_type: 'image/jpeg' }],
      usage: { cost_in_usd_ticks: 400_000_000 },
    });
    expect(out.data.toString()).toBe('jpeg-bytes');
    expect(out.extension).toBe('jpg');
    expect(out.costUsd).toBe(0.04);
    expect(extractXaiImage({ data: [{ b64_json: 'cG5n', mime_type: 'image/png' }] }).extension).toBe('png');
    expect(() => extractXaiImage({ data: [{ url: 'https://imgen.x.ai/x.jpg' }] })).toThrow(
      'A xAI respondeu sem a imagem em base64; nada foi salvo.',
    );
  });
});
