import { describe, expect, it } from 'vitest';
import {
  GEMINI_OMNI_TOKEN_USD_PER_MILLION,
  VIDEO_MODEL_SPECS,
  allowedVideoDurations,
  estimateVideoCostUsd,
  geminiOmniCostUsd,
  isVideoModelRetired,
  modelPicksVideoDuration,
  videoCostPerSecondUsd,
  videoModelCard,
  videoModelSpec,
  videoModelSummary,
  videoRequestProblem,
} from './media-video-models';

const BEFORE = Date.parse('2026-10-19T12:00:00Z');
const AFTER = Date.parse('2026-10-22T00:00:00Z');

describe('media-video-models (F-1585)', () => {
  it('todo modelo tem padrão aceito por ele mesmo e preço para o padrão', () => {
    for (const [model, spec] of Object.entries(VIDEO_MODEL_SPECS)) {
      if (spec.resolutions.length > 0) {
        expect(spec.resolutions, model).toContain(spec.defaultResolution);
      } else {
        expect(spec.defaultResolution, model).toBeUndefined();
      }
      expect(videoRequestProblem(model, { hasImage: true }, BEFORE), model).toBeNull();
      if (modelPicksVideoDuration(spec)) {
        // Sem duração no pedido: o custo sai da duração do arquivo gerado.
        expect(spec.defaultDuration, model).toBeUndefined();
        expect(estimateVideoCostUsd(model, { seconds: 8 }), model).not.toBeNull();
        continue;
      }
      expect(spec.durations, model).toContain(spec.defaultDuration);
      expect(
        allowedVideoDurations(spec, { resolution: spec.defaultResolution }),
        model,
      ).toContain(spec.defaultDuration);
      expect(estimateVideoCostUsd(model, {}), model).not.toBeNull();
    }
  });

  it('recusa duração que o modelo não aceita, dizendo as aceitas', () => {
    // O Estúdio mandava 5 s (slider 2..12) para o Veo, que só aceita 4/6/8.
    expect(videoRequestProblem('google/veo-3.1', { durationSeconds: 5 }, BEFORE)).toBe(
      'google/veo-3.1 aceita 4, 6, 8 segundos (pedido: 5 s).',
    );
    expect(videoRequestProblem('veo-3.1-generate-preview', { durationSeconds: 5 }, BEFORE)).toContain(
      'aceita 4, 6, 8 segundos',
    );
    expect(videoRequestProblem('bytedance/seedance-2.0', { durationSeconds: 12 }, BEFORE)).toBeNull();
  });

  it('1080p/4k do Veo só com 8 s; Hailuo 1080p só com 6 s', () => {
    expect(
      videoRequestProblem('google/veo-3.1', { durationSeconds: 4, resolution: '1080p' }, BEFORE),
    ).toBe('google/veo-3.1 aceita 8 segundos em 1080p (pedido: 4 s).');
    expect(
      videoRequestProblem('veo-3.1-generate-preview', { durationSeconds: 8, resolution: '4k' }, BEFORE),
    ).toBeNull();
    expect(
      videoRequestProblem('minimax/hailuo-2.3', { durationSeconds: 10, resolution: '1080p' }, BEFORE),
    ).toContain('aceita 6 segundos em 1080p');
  });

  it('recusa resolução e proporção fora do modelo', () => {
    // O Estúdio mandava 720p para o Hailuo (768p|1080p).
    expect(videoRequestProblem('minimax/hailuo-2.3', { resolution: '720p' }, BEFORE)).toBe(
      'minimax/hailuo-2.3 aceita resolução 768p, 1080p (pedido: 720p).',
    );
    expect(videoRequestProblem('kwaivgi/kling-v2.5-turbo-pro', { resolution: '1080p' }, BEFORE)).toContain(
      'não deixa escolher a resolução',
    );
    expect(videoRequestProblem('google/veo-3.1', { aspectRatio: '1:1' }, BEFORE)).toBe(
      'google/veo-3.1 aceita proporção 16:9, 9:16 (pedido: 1:1).',
    );
    expect(
      videoRequestProblem('wan-video/wan-2.5-i2v', { aspectRatio: '16:9', hasImage: true }, BEFORE),
    ).toContain('não deixa escolher a proporção');
  });

  it('image-to-video sem imagem é recusado antes de pagar', () => {
    expect(videoRequestProblem('wan-video/wan-2.5-i2v', {}, BEFORE)).toContain('a partir de uma imagem inicial');
    expect(videoRequestProblem('kwaivgi/kling-v2.1', {}, BEFORE)).toContain('imagePath');
    // Ray 3.2: 10 s só sem imagem inicial.
    expect(videoRequestProblem('luma/ray-3.2', { durationSeconds: 10, hasImage: true }, BEFORE)).toContain(
      'aceita 5 segundos',
    );
    expect(videoRequestProblem('luma/ray-3.2', { durationSeconds: 10 }, BEFORE)).toBeNull();
  });

  it('Veo 3.1 preview do Gemini desliga em 22/10/2026 e aponta o substituto', () => {
    const spec = videoModelSpec('veo-3.1-generate-preview')!;
    expect(isVideoModelRetired(spec, BEFORE)).toBe(false);
    expect(isVideoModelRetired(spec, AFTER)).toBe(true);
    // F-1587: o substituto do Google usa a mesma chave do Gemini.
    expect(videoRequestProblem('veo-3.1-lite-generate-preview', {}, AFTER)).toBe(
      'O fornecedor desligou o veo-3.1-lite-generate-preview em 22/10/2026; ' +
        'use gemini-omni-1.1-flash, com a mesma chave do Gemini.',
    );
    expect(isVideoModelRetired(videoModelSpec('google/veo-3.1')!, AFTER)).toBe(false);
    expect(isVideoModelRetired(videoModelSpec('gemini-omni-1.1-flash')!, AFTER)).toBe(false);
  });

  it('F-1587: Gemini Omni não aceita duração no pedido e cobra por resolução', () => {
    const spec = videoModelSpec('gemini-omni-1.1-flash')!;
    expect(modelPicksVideoDuration(spec)).toBe(true);
    expect(videoRequestProblem('gemini-omni-1.1-flash', { durationSeconds: 8 }, BEFORE)).toBe(
      'gemini-omni-1.1-flash não deixa escolher a duração (o modelo decide): tire a duração do pedido.',
    );
    expect(videoRequestProblem('gemini-omni-1.1-flash', { resolution: '480p' }, BEFORE)).toBe(
      'gemini-omni-1.1-flash aceita resolução 360p, 720p, 1080p, 4k (pedido: 480p).',
    );
    expect(videoRequestProblem('gemini-omni-1.1-flash', { aspectRatio: '1:1' }, BEFORE)).toContain(
      'aceita proporção 16:9, 9:16',
    );
    expect(
      videoRequestProblem('gemini-omni-1.1-flash', { resolution: '4k', aspectRatio: '9:16' }, BEFORE),
    ).toBeNull();
    // Tabela do anúncio do Google (27/08/2026), por segundo.
    expect(videoCostPerSecondUsd('gemini-omni-1.1-flash', '360p')).toBe(0.03);
    expect(videoCostPerSecondUsd('gemini-omni-1.1-flash')).toBe(0.1);
    expect(videoCostPerSecondUsd('gemini-omni-1.1-flash', '1080p')).toBe(0.15);
    expect(videoCostPerSecondUsd('gemini-omni-1.1-flash', '4k')).toBe(0.3);
    // Sem a duração do arquivo não há custo inventado.
    expect(estimateVideoCostUsd('gemini-omni-1.1-flash', {})).toBeNull();
    expect(estimateVideoCostUsd('gemini-omni-1.1-flash', { seconds: 8, resolution: '4k' })).toBe(2.4);
    expect(estimateVideoCostUsd('gemini-omni-1.1-flash', { seconds: 8.04 })).toBe(0.804);
    expect(videoCostPerSecondUsd('minimax/hailuo-2.3')).toBeNull();
  });

  it('F-1587: custo do Omni pelos tokens que o Google cobrou (geração real de 19/10/2026)', () => {
    // 360p, 10 s: 19.310 tokens de vídeo = 1.930/s (1/3 dos 5.792/s do 720p);
    // a tabela por segundo arredonda para $0.30, o Google cobra $0.3407.
    expect(geminiOmniCostUsd({ inputTokens: 22, videoTokens: 19310, textTokens: 304 })).toBe(0.3407);
    expect(geminiOmniCostUsd({ inputTokens: 0, videoTokens: 57920, textTokens: 0 })).toBe(1.0136);
  });

  it('custo de lista por segundo ou por vídeo; combinação sem preço é null', () => {
    expect(estimateVideoCostUsd('google/veo-3.1', { seconds: 8 })).toBe(3.2);
    expect(estimateVideoCostUsd('kwaivgi/kling-v3-video', { seconds: 5 })).toBe(1.12);
    expect(estimateVideoCostUsd('openai/sora-2-pro', { seconds: 12, resolution: '1024p' })).toBe(6);
    expect(estimateVideoCostUsd('luma/ray-3.2', { seconds: 5, resolution: '540p' })).toBe(0.15);
    expect(estimateVideoCostUsd('minimax/hailuo-2.3', { seconds: 10, resolution: '1080p' })).toBeNull();
    expect(estimateVideoCostUsd('modelo/desconhecido', { seconds: 5 })).toBeNull();
  });

  it('modelo fora da tabela fica com o serviço (sem recusa inventada)', () => {
    expect(videoRequestProblem('modelo/novo', { durationSeconds: 99 }, BEFORE)).toBeNull();
  });
});

describe('videoModelSummary (F-1585)', () => {
  it('resume durações, resoluções, preço e avisos', () => {
    expect(videoModelSummary('google/veo-3.1', BEFORE)).toBe('4, 6, 8 s · 720p, 1080p · $0.40/s');
    expect(videoModelSummary('bytedance/seedance-2.0', BEFORE)).toBe(
      '4–15 s · 480p, 720p, 1080p, 4k · a partir de $0.08/s',
    );
    expect(videoModelSummary('minimax/hailuo-2.3', BEFORE)).toBe('6, 10 s · 768p, 1080p · a partir de $0.28 por vídeo');
    expect(videoModelSummary('wan-video/wan-2.5-i2v', BEFORE)).toContain('precisa de imagem inicial');
    expect(videoModelSummary('veo-3.1-generate-preview', BEFORE)).toContain('desliga em 22/10/2026');
    expect(videoModelSummary('veo-3.1-generate-preview', AFTER)).toContain('desligado em 22/10/2026');
    expect(videoModelSummary('gemini-omni-1.1-flash', AFTER)).toBe(
      'duração escolhida pelo modelo · 360p, 720p, 1080p, 4k · a partir de $0.03/s',
    );
    expect(videoModelSummary('modelo/novo')).toBeNull();
  });

  it('revisão #145: imagens de entrada do Grok Imagine somam ao custo e aparecem no cartão', () => {
    // INPUT PRICING de cada modelo em docs.x.ai (19/10/2026): 1.5 e lite US$ 0,01, clássico US$ 0,002.
    expect(estimateVideoCostUsd('grok-imagine-video-1.5', { seconds: 8, resolution: '720p' })).toBe(1.12);
    expect(
      estimateVideoCostUsd('grok-imagine-video-1.5', { seconds: 8, resolution: '720p', inputImages: 14 }),
    ).toBe(1.26);
    expect(estimateVideoCostUsd('grok-imagine-video', { seconds: 8, inputImages: 2 })).toBe(0.564);
    // Modelo sem cobrança por imagem de entrada não muda.
    expect(estimateVideoCostUsd('google/veo-3.1', { seconds: 8, inputImages: 3 })).toBe(3.2);
    expect(videoModelCard('grok-imagine-video-1.5-lite')?.price).toMatchObject({ inputImageUsd: 0.01 });
    expect(videoModelCard('google/veo-3.1')?.price).not.toHaveProperty('inputImageUsd');
  });

  it('F-1599: Grok Imagine com o preço por resolução da página de preços da xAI', () => {
    expect(videoModelSummary('grok-imagine-video-1.5', BEFORE)).toBe(
      '1–15 s · 480p, 720p, 1080p · a partir de $0.08/s',
    );
    expect(videoModelSummary('grok-imagine-video-1.5-lite', BEFORE)).toBe(
      '1–15 s · 480p, 720p, 1080p · a partir de $0.02/s',
    );
    expect(videoModelSummary('grok-imagine-video', BEFORE)).toBe('1–15 s · 480p, 720p · a partir de $0.05/s');
  });
});

describe('F-1599: Grok Imagine na tabela de vídeo', () => {
  it('1–15 s, padrão 8 s em 720p, e o clássico vai só até 720p', () => {
    for (const model of ['grok-imagine-video-1.5', 'grok-imagine-video-1.5-lite', 'grok-imagine-video']) {
      const spec = videoModelSpec(model)!;
      expect(spec.durations).toEqual(Array.from({ length: 15 }, (_, i) => i + 1));
      expect(spec.defaultDuration).toBe(8);
      expect(spec.defaultResolution).toBe('720p');
      expect(spec.aspectRatios).toEqual(['16:9', '9:16', '1:1', '4:3', '3:4', '3:2', '2:3', '21:9', '5:2']);
    }
    expect(videoRequestProblem('grok-imagine-video', { resolution: '1080p' }, BEFORE)).toBe(
      'grok-imagine-video aceita resolução 480p, 720p (pedido: 1080p).',
    );
    expect(videoRequestProblem('grok-imagine-video-1.5', { durationSeconds: 0 }, BEFORE)).toContain('aceita 1, 2, 3');
    expect(videoRequestProblem('grok-imagine-video-1.5', { durationSeconds: 15, resolution: '1080p', aspectRatio: '5:2' }, BEFORE)).toBeNull();
  });

  it('custo: segundos × preço da resolução (docs.x.ai/developers/pricing, 10/10/2026)', () => {
    expect(estimateVideoCostUsd('grok-imagine-video-1.5', { seconds: 10, resolution: '1080p' })).toBe(2.5);
    expect(estimateVideoCostUsd('grok-imagine-video-1.5', { seconds: 8, resolution: '480p' })).toBe(0.64);
    expect(estimateVideoCostUsd('grok-imagine-video-1.5-lite', { seconds: 8, resolution: '720p' })).toBe(0.24);
    expect(estimateVideoCostUsd('grok-imagine-video-1.5-lite', { seconds: 5, resolution: '1080p' })).toBe(0.7);
    expect(estimateVideoCostUsd('grok-imagine-video', { seconds: 15, resolution: '720p' })).toBe(1.05);
    expect(estimateVideoCostUsd('grok-imagine-video', { resolution: '1080p' })).toBeNull();
  });
});

describe('videoModelCard (F-1598)', () => {
  it('o cartão só anuncia o que o motor aceita, para todo modelo da tabela', () => {
    for (const model of Object.keys(VIDEO_MODEL_SPECS)) {
      const card = videoModelCard(model, BEFORE)!;
      expect(card, model).not.toBeNull();
      expect(JSON.parse(JSON.stringify(card)), model).toEqual(card);
      expect(card.defaultRequestCostUsd, model).toBe(estimateVideoCostUsd(model, {}));
      const hasImage = card.requiresImage || undefined;
      for (const resolution of card.resolutions.length > 0 ? card.resolutions : [undefined]) {
        expect(videoRequestProblem(model, { resolution, hasImage }, BEFORE), `${model} ${resolution}`).toBeNull();
        const allowed = card.durationsSeconds === null
          ? []
          : card.durationsSeconds.filter((d) =>
              !resolution || !card.durationsByResolution?.[resolution] || card.durationsByResolution[resolution].includes(d),
            );
        for (const durationSeconds of allowed) {
          expect(
            videoRequestProblem(model, { resolution, durationSeconds, hasImage }, BEFORE),
            `${model} ${resolution} ${durationSeconds}s`,
          ).toBeNull();
        }
      }
      for (const aspectRatio of card.aspectRatios) {
        expect(videoRequestProblem(model, { aspectRatio, hasImage }, BEFORE), `${model} ${aspectRatio}`).toBeNull();
      }
      if (card.aspectRatios.length === 0) {
        expect(videoRequestProblem(model, { aspectRatio: '16:9', hasImage }, BEFORE), model).not.toBeNull();
      }
      if (card.resolutions.length === 0) {
        expect(card.defaultResolution, model).toBeNull();
        expect(videoRequestProblem(model, { resolution: '720p', hasImage }, BEFORE), model).not.toBeNull();
      }
      if (card.requiresImage) {
        expect(videoRequestProblem(model, {}, BEFORE), model).not.toBeNull();
      }
    }
  });

  it('Gemini Omni: duração é do modelo, cobra por token e o pedido padrão não tem custo antes', () => {
    expect(videoModelCard('gemini-omni-1.1-flash', BEFORE)).toMatchObject({
      durationsSeconds: null,
      defaultDurationSeconds: null,
      resolutions: ['360p', '720p', '1080p', '4k'],
      defaultResolution: '720p',
      aspectRatios: ['16:9', '9:16'],
      requiresImage: false,
      price: {
        unit: 'usd-per-second',
        default: 0.1,
        byResolution: { '360p': 0.03, '720p': 0.1, '1080p': 0.15, '4k': 0.3 },
        billedByTokensUsdPerMillion: { input: 1.5, textOutput: 9, videoOutput: 17.5 },
      },
      defaultRequestCostUsd: null,
      retiresOn: null,
      retired: false,
      replacement: null,
    });
    expect(videoModelCard('gemini-omni-1.1-flash', BEFORE)!.summary).toContain('duração escolhida pelo modelo');
  });

  it('Veo 3.1 preview: data de desligamento, substituto e 1080p/4k só com 8 s', () => {
    const before = videoModelCard('veo-3.1-generate-preview', BEFORE)!;
    expect(before).toMatchObject({
      durationsSeconds: [4, 6, 8],
      defaultDurationSeconds: 8,
      durationsByResolution: { '1080p': [8], '4k': [8] },
      retiresOn: '2026-10-22',
      retired: false,
      defaultRequestCostUsd: 3.2,
    });
    expect(before.replacement).toContain('gemini-omni-1.1-flash');
    expect(before.price).not.toHaveProperty('billedByTokensUsdPerMillion');
    expect(videoModelCard('veo-3.1-generate-preview', AFTER)!.retired).toBe(true);
  });

  it('preço que não varia por resolução, por vídeo e duração restrita com imagem', () => {
    expect(videoModelCard('google/veo-3.1', BEFORE)!.price).toEqual({
      unit: 'usd-per-second',
      default: 0.4,
      byResolution: { '720p': 0.4, '1080p': 0.4 },
    });
    expect(videoModelCard('kwaivgi/kling-v2.5-turbo-pro', BEFORE)).toMatchObject({
      resolutions: [],
      defaultResolution: null,
      price: { unit: 'usd-per-second', default: 0.07 },
    });
    expect(videoModelCard('kwaivgi/kling-v2.5-turbo-pro', BEFORE)!.price).not.toHaveProperty('byResolution');
    expect(videoModelCard('minimax/hailuo-2.3', BEFORE)!.price).toEqual({
      unit: 'usd-per-video',
      byResolution: { '768p': { 6: 0.28, 10: 0.56 }, '1080p': { 6: 0.49 } },
    });
    expect(videoModelCard('luma/ray-3.2', BEFORE)).toMatchObject({ durationsSeconds: [5, 10], durationsWithImage: [5] });
    expect(videoModelCard('wan-video/wan-2.5-i2v', BEFORE)).toMatchObject({ requiresImage: true, aspectRatios: [] });
  });

  it('o cartão é cópia: mexer nele não muda a tabela', () => {
    const card = videoModelCard('bytedance/seedance-2.0', BEFORE)!;
    (card.durationsSeconds as number[]).push(99);
    (card.resolutions as string[]).length = 0;
    expect(videoModelSpec('bytedance/seedance-2.0')!.durations).not.toContain(99);
    expect(videoModelSpec('bytedance/seedance-2.0')!.resolutions).toContain('720p');
  });

  it('modelo fora da tabela não ganha cartão inventado', () => {
    expect(videoModelCard('acme/video-9', BEFORE)).toBeNull();
  });

  it('o custo do Omni pelos tokens usa o mesmo preço que o cartão mostra', () => {
    expect(GEMINI_OMNI_TOKEN_USD_PER_MILLION).toEqual({ input: 1.5, textOutput: 9, videoOutput: 17.5 });
    expect(geminiOmniCostUsd({ inputTokens: 1_000_000, textTokens: 0, videoTokens: 0 })).toBe(1.5);
    expect(geminiOmniCostUsd({ inputTokens: 0, textTokens: 1_000_000, videoTokens: 0 })).toBe(9);
    expect(geminiOmniCostUsd({ inputTokens: 0, textTokens: 0, videoTokens: 1_000_000 })).toBe(17.5);
  });
});
