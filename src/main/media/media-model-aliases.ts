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
  // Seedance 2.5 (F-1612): até 30 s e 30 referências; só 480p/720p.
  'seedance-2.5': 'bytedance/seedance-2.5',
  seedance25: 'bytedance/seedance-2.5',
  'seedance-25': 'bytedance/seedance-2.5',
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
  // F-1612: MiniMax H3 (= Hailuo 3), Wan 3.0, PixVerse v6, Vidu Q3 Pro.
  h3: 'minimax/h3',
  'hailuo-3': 'minimax/h3',
  hailuo3: 'minimax/h3',
  'minimax-h3': 'minimax/h3',
  'wan-3': 'alibaba/wan-3',
  wan3: 'alibaba/wan-3',
  'wan-3-prime': 'alibaba/wan-3-prime',
  pixverse: 'pixverse/pixverse-v6',
  'pixverse-v6': 'pixverse/pixverse-v6',
  vidu: 'vidu/q3-pro',
  'vidu-q3': 'vidu/q3-pro',
  'gemini-omni-replicate': 'google/gemini-omni-1.1',
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
  // Grok Imagine (xAI, F-1599) — nomes que já dizem o tipo. Nunca um id real
  // (`grok-imagine-video` e `grok-imagine-image` são modelos, não apelidos).
  'grok-image': 'grok-imagine-image-2.0',
  'grok-image-2': 'grok-imagine-image-2.0',
  'grok-image-quality': 'grok-imagine-image-quality',
  'grok-image-pro': 'grok-imagine-image-quality',
  'grok-video': 'grok-imagine-video-1.5',
  'grok-video-1.5': 'grok-imagine-video-1.5',
  'grok-video-lite': 'grok-imagine-video-1.5-lite',
  'grok-video-classic': 'grok-imagine-video',
};

/**
 * Apelidos que dependem do tipo pedido: "grok" na ferramenta de imagem é o
 * Grok Imagine Image, na de vídeo é o Grok Imagine Video (F-1599).
 */
const KIND_ALIASES: Partial<Record<MediaKind, Record<string, string>>> = {
  image: {
    grok: 'grok-imagine-image-2.0',
    'grok-imagine': 'grok-imagine-image-2.0',
    imagine: 'grok-imagine-image-2.0',
  },
  video: {
    grok: 'grok-imagine-video-1.5',
    'grok-imagine': 'grok-imagine-video-1.5',
    imagine: 'grok-imagine-video-1.5',
  },
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
  kind?: MediaKind,
): string | undefined {
  if (!raw?.trim()) return undefined;
  const key = normalizeMediaAlias(raw);
  return (kind ? KIND_ALIASES[kind]?.[key] : undefined) ?? ALIASES[key];
}

/** Public map for MCP `nexus_media_providers` (agents must not invent ids). */
export function listMediaModelAliases(): Record<string, string> {
  return { ...ALIASES };
}

/** Apelidos que mudam com o tipo (`grok` → imagem ou vídeo), para o MCP. */
export function listMediaModelAliasesByKind(): Partial<Record<MediaKind, Record<string, string>>> {
  return Object.fromEntries(
    Object.entries(KIND_ALIASES).map(([kind, aliases]) => [kind, { ...aliases }]),
  );
}
