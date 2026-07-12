import { describe, expect, it } from 'vitest';
import {
  listMediaModelAliases,
  normalizeMediaAlias,
  resolveMediaModelAlias,
} from './media-model-aliases';
import {
  findMediaProvider,
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

  it('exports a non-empty alias map for MCP', () => {
    const aliases = listMediaModelAliases();
    expect(aliases.seedance).toBe('bytedance/seedance-2.0');
    expect(Object.keys(aliases).length).toBeGreaterThan(10);
  });
});
