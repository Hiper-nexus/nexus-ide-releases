import { describe, expect, it } from 'vitest';
import type { MediaProviderInfo } from '../../shared/media-types';
import {
  firstUsableModel,
  studioCostUsd,
  studioModelBlock,
  studioNeedsImage,
  studioReferencePlan,
  studioReferenceRequest,
  studioRetirementNotice,
  studioVideoChoices,
  studioVideoPerSecondUsd,
} from './media-studio-options';

const BEFORE = Date.parse('2026-10-19T12:00:00Z');
const AFTER = Date.parse('2026-10-23T12:00:00Z');

function provider(patch: Partial<MediaProviderInfo>): MediaProviderInfo {
  return {
    id: 'replicate-video',
    kind: 'video',
    label: 'Replicate',
    envVar: 'REPLICATE_API_TOKEN',
    defaultModel: 'bytedance/seedance-2.0',
    models: ['bytedance/seedance-2.0'],
    hasKey: true,
    maskedKey: null,
    ...patch,
  };
}

describe('media-studio-options (F-1585)', () => {
  it('troca a escolha antiga pelo que o modelo aceita', () => {
    // O padrão antigo do Estúdio (5 s, 720p) no Veo: 5 s não existe → 8 s.
    const veo = studioVideoChoices('google/veo-3.1', { aspect: '16:9', resolution: '720p', duration: 5 });
    expect(veo).toMatchObject({ durations: [4, 6, 8], duration: 8, resolution: '720p', aspect: '16:9' });
    // 1080p só com 8 s.
    expect(studioVideoChoices('google/veo-3.1', { aspect: '16:9', resolution: '1080p', duration: 4 }))
      .toMatchObject({ durations: [8], duration: 8 });
    // Hailuo: 720p não existe → 768p; proporção não se escolhe.
    expect(studioVideoChoices('minimax/hailuo-2.3', { aspect: '16:9', resolution: '720p', duration: 5 }))
      .toMatchObject({ resolution: '768p', duration: 6, aspect: undefined, aspects: [] });
    // Kling 2.5 Turbo Pro: sem escolha de resolução.
    expect(studioVideoChoices('kwaivgi/kling-v2.5-turbo-pro', { aspect: '1:1', resolution: '1080p', duration: 10 }))
      .toMatchObject({ resolution: undefined, resolutions: [], duration: 10, aspect: '1:1' });
  });

  it('bloqueia o que o Estúdio não consegue gerar', () => {
    // F-1611: image-to-video gera com uma imagem das Referências — não bloqueia.
    expect(studioModelBlock('wan-video/wan-2.5-i2v', BEFORE)).toBeNull();
    expect(studioNeedsImage('wan-video/wan-2.5-i2v')).toBe(true);
    expect(studioNeedsImage('google/veo-3.1')).toBe(false);
    expect(studioModelBlock('veo-3.1-generate-preview', BEFORE)).toBeNull();
    expect(studioModelBlock('veo-3.1-generate-preview', AFTER)).toBe('desligado em 22/10/2026');
    expect(studioModelBlock('gpt-image-2', BEFORE)).toBeNull();
  });

  it('o padrão pula modelo bloqueado e serviço sem modelo que gere', () => {
    const google = provider({
      id: 'google-video',
      defaultModel: 'veo-3.1-generate-preview',
      models: ['veo-3.1-generate-preview', 'veo-3.1-fast-generate-preview'],
    });
    const i2v = provider({ defaultModel: 'wan-video/wan-2.5-i2v', models: ['wan-video/wan-2.5-i2v', 'google/veo-3.1'] });
    expect(firstUsableModel([i2v], BEFORE)).toEqual({ providerId: 'replicate-video', model: 'google/veo-3.1' });
    expect(firstUsableModel([google, i2v], AFTER)).toEqual({ providerId: 'replicate-video', model: 'google/veo-3.1' });
    expect(firstUsableModel([google], AFTER)).toBeNull();
    // F-1587: com o Omni na lista, o serviço do Google segue gerando depois de 22/10.
    const withOmni = provider({
      id: 'google-video',
      defaultModel: 'gemini-omni-1.1-flash',
      models: ['gemini-omni-1.1-flash', 'veo-3.1-generate-preview'],
    });
    expect(firstUsableModel([withOmni], AFTER)).toEqual({
      providerId: 'google-video',
      model: 'gemini-omni-1.1-flash',
    });
  });

  it('F-1587: Omni não tem duração a escolher; antes de gerar, só a taxa por segundo', () => {
    const omni = studioVideoChoices('gemini-omni-1.1-flash', {
      aspect: '1:1',
      resolution: '768p',
      duration: 5,
    });
    expect(omni).toMatchObject({
      durations: [],
      duration: undefined,
      resolution: '720p',
      resolutions: ['360p', '720p', '1080p', '4k'],
      aspect: '16:9',
    });
    expect(studioCostUsd('video', undefined, 'gemini-omni-1.1-flash', omni)).toBeNull();
    expect(studioVideoPerSecondUsd('gemini-omni-1.1-flash', omni)).toBe(0.1);
    const draft = studioVideoChoices('gemini-omni-1.1-flash', {
      aspect: '9:16',
      resolution: '360p',
      duration: 5,
    });
    expect(studioVideoPerSecondUsd('gemini-omni-1.1-flash', draft)).toBe(0.03);
    // Modelo com duração escolhida mostra o total, não a taxa.
    const veo = studioVideoChoices('google/veo-3.1', { aspect: '16:9', resolution: '720p', duration: 8 });
    expect(studioVideoPerSecondUsd('google/veo-3.1', veo)).toBeNull();
  });

  it('avisa do desligamento só antes da data', () => {
    expect(studioRetirementNotice('veo-3.1-lite-generate-preview', BEFORE)).toBe(
      'O fornecedor desliga este modelo em 22/10/2026. ' +
        'Depois disso, use gemini-omni-1.1-flash, com a mesma chave do Gemini.',
    );
    expect(studioRetirementNotice('veo-3.1-lite-generate-preview', AFTER)).toBeNull();
    expect(studioRetirementNotice('google/veo-3.1', BEFORE)).toBeNull();
  });

  it('custo de lista antes de gerar: vídeo pela tabela, imagem pelo provedor', () => {
    expect(studioCostUsd('video', undefined, 'google/veo-3.1', { duration: 8, resolution: '720p' })).toBe(3.2);
    const image = provider({ id: 'openai-image', kind: 'image', imageCostUsd: { 'gpt-image-2': 0.07 } });
    expect(studioCostUsd('image', image, 'gpt-image-2')).toBe(0.07);
    expect(studioCostUsd('image', image, 'outro')).toBeNull();
  });

  it('F-1599: Grok Imagine oferece 1–15 s e as resoluções do modelo, com o custo antes de gerar', () => {
    const video15 = studioVideoChoices('grok-imagine-video-1.5', { aspect: '21:9', resolution: '1080p', duration: 12 });
    expect(video15).toMatchObject({ aspect: '21:9', resolution: '1080p', duration: 12 });
    expect(video15.durations).toHaveLength(15);
    expect(video15.resolutions).toEqual(['480p', '720p', '1080p']);
    // O clássico não faz 1080p: cai no padrão dele, mantendo duração e proporção.
    const classic = studioVideoChoices('grok-imagine-video', { aspect: '21:9', resolution: '1080p', duration: 12 });
    expect(classic).toMatchObject({ aspect: '21:9', resolution: '720p', duration: 12 });
    expect(studioCostUsd('video', undefined, 'grok-imagine-video', classic)).toBe(0.84);
    expect(studioCostUsd('video', undefined, 'grok-imagine-video-1.5', { duration: 5, resolution: '720p' })).toBe(0.7);
    expect(studioVideoPerSecondUsd('grok-imagine-video-1.5', video15)).toBeNull();
    const xai = provider({
      id: 'xai-video',
      label: 'xAI — Grok Imagine (vídeo)',
      envVar: 'XAI_API_KEY',
      defaultModel: 'grok-imagine-video-1.5',
      models: ['grok-imagine-video-1.5', 'grok-imagine-video-1.5-lite', 'grok-imagine-video'],
    });
    expect(firstUsableModel([xai], BEFORE)).toEqual({ providerId: 'xai-video', model: 'grok-imagine-video-1.5' });
    expect(studioModelBlock('grok-imagine-video-1.5-lite', AFTER)).toBeNull();
  });
});

describe('F-1611: o que as Referências viram em cada modelo', () => {
  it('imagem: Seedream recebe até 10; os outros editam uma', () => {
    expect(studioReferencePlan('image', 'replicate-image', 'bytedance/seedream-5-pro').max).toBe(10);
    expect(studioReferencePlan('image', 'openai-image', 'gpt-image-2').max).toBe(1);
    expect(studioReferenceRequest('image', ['a', 'b', 'c'])).toEqual({
      imagePath: 'a',
      referenceImagePaths: ['b', 'c'],
    });
    expect(studioReferenceRequest('image', ['a'])).toEqual({ imagePath: 'a' });
    expect(studioReferenceRequest('image', [])).toEqual({});
  });

  it('vídeo: teto da tabela; 1 imagem é o primeiro quadro, 2+ só referência', () => {
    expect(studioReferencePlan('video', 'replicate-video', 'bytedance/seedance-2.5').max).toBe(30);
    expect(studioReferencePlan('video', 'replicate-video', 'google/veo-3.1').max).toBe(3);
    expect(studioReferencePlan('video', 'replicate-video', 'minimax/h3')).toEqual({
      max: 1,
      hint: 'A imagem escolhida vira o primeiro quadro do vídeo.',
    });
    expect(studioReferenceRequest('video', ['a'])).toEqual({ imagePath: 'a' });
    expect(studioReferenceRequest('video', ['a', 'b'])).toEqual({ referenceImagePaths: ['a', 'b'] });
  });
});
