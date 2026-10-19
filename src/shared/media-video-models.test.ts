import { describe, expect, it } from 'vitest';
import {
  VIDEO_MODEL_SPECS,
  allowedVideoDurations,
  estimateVideoCostUsd,
  geminiOmniCostUsd,
  isVideoModelRetired,
  modelPicksVideoDuration,
  videoCostPerSecondUsd,
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
});
