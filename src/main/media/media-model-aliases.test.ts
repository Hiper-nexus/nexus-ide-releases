import { describe, expect, it } from 'vitest';
import {
  listMediaModelAliases,
  normalizeMediaAlias,
  resolveMediaModelAlias,
} from './media-model-aliases';
import {
  findMediaProvider,
  MEDIA_PROVIDERS,
  resolveMediaModel,
  resolveMediaProvider,
} from './media-providers';

describe('media model aliases', () => {
  it('normalizes spaces and underscores', () => {
    expect(normalizeMediaAlias('Seedance Fast')).toBe('seedance-fast');
    expect(normalizeMediaAlias('kling_omni')).toBe('kling-omni');
  });

  it('resolves flagship friendly names', () => {
    // Seedream = image (5.x); Seedance = video (2.x) — different products.
    expect(resolveMediaModelAlias('seedream')).toBe(
      'bytedance/seedream-5-pro',
    );
    expect(resolveMediaModelAlias('seedream-5')).toBe(
      'bytedance/seedream-5-pro',
    );
    // URL slug: seed.bytedance.com/en/seedream5_0_pro
    expect(resolveMediaModelAlias('seedream5_0_pro')).toBe(
      'bytedance/seedream-5-pro',
    );
    expect(resolveMediaModelAlias('seedream5-0-pro')).toBe(
      'bytedance/seedream-5-pro',
    );
    expect(resolveMediaModelAlias('seedream-5.0-pro')).toBe(
      'bytedance/seedream-5-pro',
    );
    expect(resolveMediaModelAlias('seedream-lite')).toBe(
      'bytedance/seedream-5-lite',
    );
    expect(resolveMediaModelAlias('seedance')).toBe('bytedance/seedance-2.0');
    expect(resolveMediaModelAlias('veo')).toBe('google/veo-3.1');
    expect(resolveMediaModelAlias('kling')).toBe('kwaivgi/kling-v3-video');
    expect(resolveMediaModelAlias('sora')).toBe('openai/sora-2');
    expect(resolveMediaModelAlias('runway')).toBe('runwayml/gen-4.5');
    expect(resolveMediaModelAlias('luma')).toBe('luma/ray-3.2');
    expect(resolveMediaModelAlias('veo-native')).toBe(
      'veo-3.1-generate-preview',
    );
  });

  it('resolveMediaModel accepts aliases against the whitelist', () => {
    const image = findMediaProvider('replicate-image')!;
    expect(resolveMediaModel(image, 'seedream')).toBe(
      'bytedance/seedream-5-pro',
    );
    const video = findMediaProvider('replicate-video')!;
    expect(resolveMediaModel(video, 'seedance')).toBe('bytedance/seedance-2.0');
    expect(resolveMediaModel(video, 'veo-fast')).toBe('google/veo-3.1-fast');
    expect(resolveMediaModel(video, 'sora-pro')).toBe('openai/sora-2-pro');
  });

  it('resolveMediaProvider picks the provider that owns the preferred model', () => {
    const def = resolveMediaProvider(
      'video',
      undefined,
      (p) => p.id === 'google-video',
      'veo-native',
    );
    expect(def.id).toBe('google-video');
  });

  it('F-1587: "omni" é o Gemini Omni do google-video; "kling-omni" segue sendo o Kling', () => {
    expect(resolveMediaModelAlias('Gemini Omni')).toBe('gemini-omni-1.1-flash');
    expect(resolveMediaModelAlias('omni')).toBe('gemini-omni-1.1-flash');
    expect(resolveMediaModelAlias('kling omni')).toBe('kwaivgi/kling-v3-omni-video');
    const google = findMediaProvider('google-video')!;
    expect(google.defaultModel).toBe('gemini-omni-1.1-flash');
    expect(resolveMediaModel(google, 'omni-flash')).toBe('gemini-omni-1.1-flash');
    // Com as duas chaves, o modelo pedido escolhe o serviço que o tem.
    expect(resolveMediaProvider('video', undefined, () => true, 'omni').id).toBe('google-video');
  });

  it('F-1599: "grok" é a imagem do Grok Imagine na imagem e o vídeo no vídeo', () => {
    expect(resolveMediaModelAlias('grok', 'image')).toBe('grok-imagine-image-2.0');
    expect(resolveMediaModelAlias('Grok Imagine', 'video')).toBe('grok-imagine-video-1.5');
    expect(resolveMediaModelAlias('grok')).toBeUndefined();
    expect(resolveMediaModelAlias('grok video lite')).toBe('grok-imagine-video-1.5-lite');
    const video = findMediaProvider('xai-video')!;
    const image = findMediaProvider('xai-image')!;
    expect(resolveMediaModel(video, 'grok')).toBe('grok-imagine-video-1.5');
    expect(resolveMediaModel(image, 'grok')).toBe('grok-imagine-image-2.0');
    // O id real do modelo clássico continua chegando a ele.
    expect(resolveMediaModel(video, 'grok-imagine-video')).toBe('grok-imagine-video');
    expect(resolveMediaModel(image, 'grok-imagine-image')).toBe('grok-imagine-image');
    // Com todas as chaves, "grok" escolhe o serviço da xAI.
    expect(resolveMediaProvider('video', undefined, () => true, 'grok').id).toBe('xai-video');
    expect(resolveMediaProvider('image', undefined, () => true, 'grok').id).toBe('xai-image');
  });

  it('nenhum apelido tem o nome de um modelo real (sombrearia o modelo)', () => {
    const models = new Set(MEDIA_PROVIDERS.flatMap((p) => p.models));
    const shadowing = Object.keys(listMediaModelAliases()).filter((alias) => models.has(alias));
    expect(shadowing).toEqual([]);
  });

  it('exports a non-empty alias map for MCP', () => {
    const aliases = listMediaModelAliases();
    expect(aliases.seedance).toBe('bytedance/seedance-2.0');
    expect(Object.keys(aliases).length).toBeGreaterThan(10);
  });
});
