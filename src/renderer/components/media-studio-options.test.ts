import { describe, expect, it } from 'vitest';
import type { MediaProviderInfo } from '../../shared/media-types';
import {
  firstUsableModel,
  studioCostUsd,
  studioModelBlock,
  studioRetirementNotice,
  studioVideoChoices,
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
    expect(studioModelBlock('wan-video/wan-2.5-i2v', BEFORE)).toBe('precisa de imagem inicial (peça a um agente)');
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
  });

  it('avisa do desligamento só antes da data', () => {
    expect(studioRetirementNotice('veo-3.1-lite-generate-preview', BEFORE)).toBe(
      'O fornecedor desliga este modelo em 22/10/2026. Depois disso, use google/veo-3.1 pelo Replicate.',
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
});
