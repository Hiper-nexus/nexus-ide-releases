import { describe, expect, it } from 'vitest';
import {
  computeMediaTierAlternatives,
  MEDIA_PROVIDERS,
  MediaProviderUnavailableError,
  listMediaProviders,
  resolveMediaModel,
  resolveMediaProvider,
} from './media-providers';
import { videoModelSpec } from '../../shared/media-video-models';

describe('computeMediaTierAlternatives', () => {
  it('retorna providers de imagem disponíveis quando vídeo está indisponível', () => {
    const alternatives = computeMediaTierAlternatives(
      'video',
      'sem key configurada',
      (def) => def.kind === 'image',
    );
    expect(alternatives).toHaveLength(1);
    expect(alternatives[0].kind).toBe('image');
    expect(alternatives[0].providers.length).toBeGreaterThan(0);
    expect(alternatives[0].reason).toMatch(/sem key configurada/);
  });

  it('retorna lista vazia quando nenhuma alternativa tem key', () => {
    const alternatives = computeMediaTierAlternatives(
      'video',
      'sem key',
      () => false,
    );
    expect(alternatives).toHaveLength(0);
  });

  it('não sugere alternativa da mesma tier (video não pode ser alternativa de video)', () => {
    const alternatives = computeMediaTierAlternatives(
      'video',
      'sem key',
      () => true,
    );
    expect(alternatives.every((a) => a.kind !== 'video')).toBe(true);
  });

  it('image indisponível não gera alternativa de tier inferior com provider real', () => {
    const alternatives = computeMediaTierAlternatives(
      'image',
      'sem key',
      () => false,
    );
    // nenhum provider de tier inferior existe na registry; resultado vazio
    expect(alternatives.every((a) => a.providers.length === 0 || a.kind !== 'video')).toBe(true);
  });

  it('audio não tem tier inferior — retorna lista vazia', () => {
    const alternatives = computeMediaTierAlternatives(
      'audio',
      'sem key',
      () => true,
    );
    expect(alternatives).toHaveLength(0);
  });

  it('só inclui providers e modelos dentro da whitelist (sem fallback silencioso)', () => {
    const alternatives = computeMediaTierAlternatives(
      'video',
      'sem key',
      (def) => def.kind === 'image',
    );
    for (const alt of alternatives) {
      for (const provider of alt.providers) {
        const def = MEDIA_PROVIDERS.find((p) => p.id === provider.id)!;
        expect(def).toBeDefined();
        for (const model of provider.models) {
          expect(def.models).toContain(model);
        }
      }
    }
  });

  it('inclui defaultModel no provider sugerido', () => {
    const alternatives = computeMediaTierAlternatives(
      'video',
      'sem key',
      (def) => def.kind === 'image',
    );
    for (const alt of alternatives) {
      for (const provider of alt.providers) {
        expect(provider.defaultModel).toBeTruthy();
        const def = MEDIA_PROVIDERS.find((p) => p.id === provider.id)!;
        expect(provider.defaultModel).toBe(def.defaultModel);
      }
    }
  });
});

describe('MediaProviderUnavailableError', () => {
  it('é lançado por resolveMediaProvider quando kind não tem nenhum provider com key', () => {
    expect(() =>
      resolveMediaProvider('video', undefined, () => false),
    ).toThrow(MediaProviderUnavailableError);
  });

  it('é lançado por resolveMediaProvider quando provider explícito não tem key', () => {
    expect(() =>
      resolveMediaProvider('image', 'google-image', () => false),
    ).toThrow(MediaProviderUnavailableError);
  });

  it('carrega o kind que falhou', () => {
    try {
      resolveMediaProvider('video', undefined, () => false);
      expect.fail('deveria ter lançado');
    } catch (err) {
      expect(err).toBeInstanceOf(MediaProviderUnavailableError);
      expect((err as MediaProviderUnavailableError).requestedKind).toBe('video');
    }
  });

  it('preserva a mensagem legível de configuração', () => {
    try {
      resolveMediaProvider('video', undefined, () => false);
      expect.fail('deveria ter lançado');
    } catch (err) {
      expect((err as Error).message).toMatch(/Ajustes → Serviços de mídia/);
    }
  });
});

describe('F-1585: todo modelo de vídeo da lista tem regras e preço', () => {
  it('a tabela compartilhada cobre a lista de vídeo inteira', () => {
    const videoModels = MEDIA_PROVIDERS.filter((p) => p.kind === 'video').flatMap((p) => p.models);
    expect(videoModels.length).toBeGreaterThan(0);
    for (const model of videoModels) {
      expect(videoModelSpec(model), model).not.toBeNull();
    }
  });
});

describe('F-1585: preço por imagem chega à lista de provedores', () => {
  it('imagem leva o preço de lista por modelo; vídeo e voz não', () => {
    const list = listMediaProviders(() => true, () => null);
    const seedream = list.find((p) => p.id === 'replicate-image')!;
    expect(seedream.imageCostUsd).toMatchObject({
      'bytedance/seedream-5-pro': 0.04,
      'bytedance/seedream-5-lite': 0.02,
    });
    expect(list.find((p) => p.id === 'replicate-video')!.imageCostUsd).toBeUndefined();
  });
});

describe('ElevenLabs em dia (F-1590)', () => {
  const eleven = MEDIA_PROVIDERS.find((def) => def.id === 'elevenlabs')!;

  it('o modelo de ponta é o padrão e o descontinuado saiu da lista', () => {
    expect(eleven.defaultModel).toBe('eleven_v4');
    expect(eleven.models[0]).toBe('eleven_v4');
    expect(eleven.models).toEqual(['eleven_v4', 'eleven_v4_turbo', 'eleven_flash_v2_5', 'eleven_multilingual_v2']);
    expect(eleven.models).not.toContain('eleven_turbo_v2_5');
  });

  it('custo pelo preço de API de cada modelo', () => {
    expect(eleven.estimateCost({ model: 'eleven_v4', chars: 1_000 })).toBe(0.08);
    expect(eleven.estimateCost({ model: 'eleven_multilingual_v2', chars: 900 })).toBe(0.072);
    expect(eleven.estimateCost({ model: 'eleven_v4_turbo', chars: 1_000 })).toBe(0.04);
    expect(eleven.estimateCost({ model: 'eleven_flash_v2_5', chars: 900 })).toBe(0.036);
    expect(eleven.estimateCost({ model: 'eleven_v4' })).toBeNull();
  });

  it('pedido do Turbo v2.5 ou do v3 vai para o sucessor', () => {
    expect(resolveMediaModel(eleven, 'eleven_turbo_v2_5')).toBe('eleven_flash_v2_5');
    expect(resolveMediaModel(eleven, 'eleven_v3')).toBe('eleven_v4');
  });
});
