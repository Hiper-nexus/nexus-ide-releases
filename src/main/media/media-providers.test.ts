import { describe, expect, it } from 'vitest';
import {
  computeMediaTierAlternatives,
  defaultMediaChoices,
  defaultRequestCostUsd,
  findMediaProvider,
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

describe('F-1598: sem provider, o pedido padrão mais barato pela tabela', () => {
  const keyed = (...ids: string[]) => (def: { id: string }) => ids.includes(def.id);

  it('imagem com OpenAI e Replicate (sem Gemini) vai ao Seedream 5 Pro, não ao gpt-image-2', () => {
    // Antes: a ordem da tabela mandava ao gpt-image-2 (US$ 0,07) com o
    // Seedream 5 Pro (US$ 0,04) também conectado.
    expect(resolveMediaProvider('image', undefined, keyed('openai-image', 'replicate-image')).id).toBe(
      'replicate-image',
    );
    expect(defaultRequestCostUsd(findMediaProvider('replicate-image')!)).toBe(0.04);
    expect(defaultRequestCostUsd(findMediaProvider('openai-image')!)).toBe(0.07);
  });

  it('imagem com tudo conectado continua no Gemini Flash Image (US$ 0,039)', () => {
    expect(resolveMediaProvider('image', undefined, () => true).id).toBe('google-image');
  });

  it('vídeo: custo conhecido passa na frente do desconhecido (Omni decide a duração)', () => {
    expect(defaultRequestCostUsd(findMediaProvider('replicate-video')!)).toBe(0.9);
    expect(defaultRequestCostUsd(findMediaProvider('google-video')!)).toBeNull();
    expect(resolveMediaProvider('video', undefined, () => true).id).toBe('replicate-video');
    expect(resolveMediaProvider('video', undefined, keyed('google-video')).id).toBe('google-video');
  });

  it('provider ou modelo pedido continuam vencendo o preço', () => {
    expect(resolveMediaProvider('image', 'openai-image', () => true).id).toBe('openai-image');
    expect(resolveMediaProvider('video', undefined, () => true, 'omni').id).toBe('google-video');
  });

  it('defaults diz o que roda sem provider nem modelo, e null sem chave do tipo', () => {
    expect(defaultMediaChoices(keyed('openai-image', 'replicate-image', 'google-video'))).toEqual({
      image: { provider: 'replicate-image', model: 'bytedance/seedream-5-pro', listCostUsd: 0.04 },
      video: { provider: 'google-video', model: 'gemini-omni-1.1-flash', listCostUsd: null },
      audio: null,
    });
  });
});

describe('F-1598: cartão de cada modelo de vídeo na lista de provedores', () => {
  it('todo modelo de vídeo leva o cartão; imagem e voz não', () => {
    const list = listMediaProviders(() => true, () => null, Date.parse('2026-10-19T12:00:00Z'));
    for (const provider of list) {
      if (provider.kind !== 'video') {
        expect(provider.videoModels, provider.id).toBeUndefined();
        continue;
      }
      expect(Object.keys(provider.videoModels ?? {})).toEqual(provider.models);
      for (const model of provider.models) {
        expect(provider.videoModels?.[model], model).not.toBeNull();
      }
    }
  });

  it('o desligamento segue o relógio de quem pergunta', () => {
    const veoOn = (now: number) =>
      listMediaProviders(() => true, () => null, now).find((p) => p.id === 'google-video')!.videoModels![
        'veo-3.1-fast-generate-preview'
      ]!;
    expect(veoOn(Date.parse('2026-10-21T23:59:59Z'))).toMatchObject({ retiresOn: '2026-10-22', retired: false });
    expect(veoOn(Date.parse('2026-10-22T00:00:00Z')).retired).toBe(true);
  });
});
