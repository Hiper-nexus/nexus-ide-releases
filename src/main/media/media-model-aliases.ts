import type { MediaKind } from '../../shared/media-types';

/**
 * Friendly names agents / JARVIS can use instead of full provider model ids.
 * Resolved before whitelist checks so "seedance", "veo", "kling" just work.
 */
const ALIASES: Record<string, string> = {
  // ByteDance Seedream 5.0 Pro — IMAGE
  // Official: https://seed.bytedance.com/en/seedream5_0_pro
  // Replicate: bytedance/seedream-5-pro (1K/2K, up to 10 reference images)
  seedream: 'bytedance/seedream-5-pro',
  'seedream-5': 'bytedance/seedream-5-pro',
  'seedream-5.0': 'bytedance/seedream-5-pro',
  'seedream-5-pro': 'bytedance/seedream-5-pro',
  'seedream-5.0-pro': 'bytedance/seedream-5-pro',
  'seedream-pro': 'bytedance/seedream-5-pro',
  'seedream5': 'bytedance/seedream-5-pro',
  'seedream5-0-pro': 'bytedance/seedream-5-pro',
  'seedream5-pro': 'bytedance/seedream-5-pro',
  'seedream-5-lite': 'bytedance/seedream-5-lite',
  'seedream-lite': 'bytedance/seedream-5-lite',
  'seedream-4.5': 'bytedance/seedream-4.5',
  'seedream-4': 'bytedance/seedream-4',
  'seedream-3': 'bytedance/seedream-3',
  // ByteDance Seedance 2.x — VIDEO (different product)
  seedance: 'bytedance/seedance-2.0',
  'seedance-2': 'bytedance/seedance-2.0',
  'seedance-2.0': 'bytedance/seedance-2.0',
  seedance2: 'bytedance/seedance-2.0',
  'seedance-fast': 'bytedance/seedance-2.0-fast',
  'seedance-2-fast': 'bytedance/seedance-2.0-fast',
  'seedance-mini': 'bytedance/seedance-2.0-mini',
  // Google Veo (Replicate slugs; native google-video models use their own ids)
  veo: 'google/veo-3.1',
  veo3: 'google/veo-3.1',
  'veo-3': 'google/veo-3.1',
  'veo-3.1': 'google/veo-3.1',
  'veo-fast': 'google/veo-3.1-fast',
  'veo-3.1-fast': 'google/veo-3.1-fast',
  'veo-lite': 'google/veo-3.1-lite',
  // Gemini Omni Flash (AI Studio, F-1587) — `kling-omni` segue sendo o Kling.
  omni: 'gemini-omni-1.1-flash',
  'omni-flash': 'gemini-omni-1.1-flash',
  'gemini-omni': 'gemini-omni-1.1-flash',
  'gemini-omni-flash': 'gemini-omni-1.1-flash',
  'gemini-omni-1.1': 'gemini-omni-1.1-flash',
  // Native Google Veo (AI Studio)
  'veo-native': 'veo-3.1-generate-preview',
  'veo-3.1-native': 'veo-3.1-generate-preview',
  'veo-fast-native': 'veo-3.1-fast-generate-preview',
  'veo-lite-native': 'veo-3.1-lite-generate-preview',
  // Kling
  kling: 'kwaivgi/kling-v3-video',
  kling3: 'kwaivgi/kling-v3-video',
  'kling-v3': 'kwaivgi/kling-v3-video',
  'kling-omni': 'kwaivgi/kling-v3-omni-video',
  'kling-turbo': 'kwaivgi/kling-v2.5-turbo-pro',
  // Others
  hailuo: 'minimax/hailuo-2.3',
  minimax: 'minimax/hailuo-2.3',
  wan: 'wan-video/wan-2.5-i2v',
  sora: 'openai/sora-2',
  'sora-2': 'openai/sora-2',
  'sora-pro': 'openai/sora-2-pro',
  runway: 'runwayml/gen-4.5',
  'gen-4.5': 'runwayml/gen-4.5',
  luma: 'luma/ray-3.2',
  ray: 'luma/ray-3.2',
  // Image
  nano: 'gemini-3.1-flash-image-preview',
  'nano-banana': 'gemini-3.1-flash-image-preview',
  gemini: 'gemini-3.1-flash-image-preview',
  'gpt-image': 'gpt-image-2',
};

/** Normalized lookup: trim, lower-case, collapse spaces/underscores to `-`. */
export function normalizeMediaAlias(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[_\s]+/g, '-')
    .replace(/-+/g, '-');
}

/**
 * Resolve a friendly model name to a concrete model id.
 * Returns undefined when the input is not a known alias (caller uses raw id).
 */
export function resolveMediaModelAlias(
  raw: string | undefined,
  _kind?: MediaKind,
): string | undefined {
  if (!raw?.trim()) return undefined;
  const key = normalizeMediaAlias(raw);
  return ALIASES[key];
}

/** Public map for MCP `nexus_media_providers` (agents must not invent ids). */
export function listMediaModelAliases(): Record<string, string> {
  return { ...ALIASES };
}
