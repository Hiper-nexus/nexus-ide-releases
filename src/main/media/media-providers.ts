import type {
  MediaKind,
  MediaProviderId,
  MediaProviderInfo,
} from '../../shared/media-types';
import { resolveMediaModelAlias } from './media-model-aliases';
import { resolveMediaOutputPath } from './media-path-policy';

/**
 * Media provider registry — the table that turns a stored API key into a
 * generation capability. Pure logic (no electron imports) — fully
 * unit-testable; key access is injected (see media-keys.ts for the
 * safeStorage-backed edge).
 *
 * Model whitelists are enforced with NO silent fallback: asking for a model
 * outside the list is an error, not a substitution (surfacing capability gaps
 * is part of the orchestration contract).
 */

export interface MediaProviderDef {
  id: MediaProviderId;
  kind: MediaKind;
  label: string;
  envVar: string;
  defaultModel: string;
  models: string[];
  /** Rough USD estimate per generation; null when unknown. */
  estimateCost(params: {
    model: string;
    chars?: number;
    seconds?: number;
  }): number | null;
}

export const MEDIA_PROVIDERS: MediaProviderDef[] = [
  {
    id: 'google-image',
    kind: 'image',
    label: 'Google Image (Gemini)',
    envVar: 'GEMINI_API_KEY',
    defaultModel: 'gemini-3.1-flash-image-preview',
    models: ['gemini-3.1-flash-image-preview'],
    estimateCost: () => 0.039,
  },
  {
    id: 'openai-image',
    kind: 'image',
    label: 'OpenAI Image (gpt-image)',
    envVar: 'OPENAI_API_KEY',
    defaultModel: 'gpt-image-2',
    models: ['gpt-image-2', 'gpt-image-1'],
    estimateCost: () => 0.07,
  },
  {
    id: 'replicate-image',
    kind: 'image',
    // ByteDance Seedream 5.0 Pro — multimodal image (official product page:
    // https://seed.bytedance.com/en/seedream5_0_pro). Via Replicate; shares
    // REPLICATE_API_TOKEN with replicate-video.
    label: 'Replicate — Seedream 5.0 Pro (imagem)',
    envVar: 'REPLICATE_API_TOKEN',
    defaultModel: 'bytedance/seedream-5-pro',
    models: [
      'bytedance/seedream-5-pro',
      'bytedance/seedream-5-lite',
      'bytedance/seedream-4.5',
      'bytedance/seedream-4',
      'bytedance/seedream-3',
    ],
    estimateCost: () => null,
  },
  {
    id: 'replicate-video',
    kind: 'video',
    // Flagship video path is Seedance 2.0 (ByteDance multimodal + native audio).
    // Veo / Kling / Sora / Runway / Luma share the same Replicate token.
    label: 'Replicate — vídeo (Seedance / Veo / Kling / Sora…)',
    envVar: 'REPLICATE_API_TOKEN',
    defaultModel: 'bytedance/seedance-2.0',
    models: [
      // ByteDance Seedance 2.x (video — not Seedream, which is image)
      'bytedance/seedance-2.0',
      'bytedance/seedance-2.0-fast',
      'bytedance/seedance-2.0-mini',
      // Google Veo 3.1 via Replicate
      'google/veo-3.1',
      'google/veo-3.1-fast',
      'google/veo-3.1-lite',
      // Kling (live Replicate slugs — bare kling-v3 404s)
      'kwaivgi/kling-v3-video',
      'kwaivgi/kling-v3-omni-video',
      'kwaivgi/kling-v2.5-turbo-pro',
      'kwaivgi/kling-v2.1',
      // Minimax + Wan
      'minimax/hailuo-2.3',
      'wan-video/wan-2.5-i2v',
      // Premium alternatives
      'openai/sora-2',
      'openai/sora-2-pro',
      'runwayml/gen-4.5',
      'luma/ray-3.2',
    ],
    estimateCost: () => null,
  },
  {
    id: 'google-video',
    kind: 'video',
    label: 'Google Veo nativo (AI Studio)',
    envVar: 'GEMINI_API_KEY',
    defaultModel: 'veo-3.1-generate-preview',
    models: [
      'veo-3.1-generate-preview',
      'veo-3.1-fast-generate-preview',
      'veo-3.1-lite-generate-preview',
      'veo-2.0-generate-001',
    ],
    estimateCost: () => null,
  },
  {
    id: 'elevenlabs',
    kind: 'audio',
    label: 'ElevenLabs — voz/TTS',
    envVar: 'ELEVENLABS_API_KEY',
    defaultModel: 'eleven_multilingual_v2',
    models: ['eleven_multilingual_v2', 'eleven_turbo_v2_5'],
    estimateCost: ({ chars }) =>
      typeof chars === 'number'
        ? Number(((chars / 1_000) * 0.18).toFixed(4))
        : null,
  },
];

export function findMediaProvider(id: string): MediaProviderDef | null {
  return MEDIA_PROVIDERS.find((p) => p.id === id) ?? null;
}

/**
 * Pick the provider for a request. Explicit provider: must exist, match the
 * kind and have a key — otherwise error (never silently substitute).
 * No provider: if preferredModel is set, prefer a keyed provider that lists it;
 * else cheapest provider of the kind WITH a key (table order).
 */
export function resolveMediaProvider(
  kind: MediaKind,
  requested: string | undefined,
  hasKeyFn: (def: MediaProviderDef) => boolean,
  preferredModel?: string,
): MediaProviderDef {
  if (requested) {
    const def = findMediaProvider(requested);
    if (!def) throw new Error(`provider desconhecido: ${requested}`);
    if (def.kind !== kind) {
      throw new Error(`provider ${requested} é de ${def.kind}, não de ${kind}`);
    }
    if (!hasKeyFn(def)) {
      throw new Error(
        `provider ${requested} sem key — configure em Settings → Mídia`,
      );
    }
    return def;
  }

  if (preferredModel) {
    const resolved =
      resolveMediaModelAlias(preferredModel, kind) ?? preferredModel;
    const match = MEDIA_PROVIDERS.find(
      (p) => p.kind === kind && hasKeyFn(p) && p.models.includes(resolved),
    );
    if (match) return match;
  }

  const available = MEDIA_PROVIDERS.filter(
    (p) => p.kind === kind && hasKeyFn(p),
  );
  if (available.length === 0) {
    throw new Error(
      `nenhum provider de ${kind} com key configurada — configure em ` +
        'Settings → Mídia',
    );
  }
  return available[0];
}

/** Model must be whitelisted for the provider — no silent fallback. */
export function resolveMediaModel(
  def: MediaProviderDef,
  requested: string | undefined,
): string {
  if (!requested) return def.defaultModel;
  const resolved =
    resolveMediaModelAlias(requested, def.kind) ?? requested.trim();
  if (!def.models.includes(resolved)) {
    throw new Error(
      `modelo ${requested} não habilitado para ${def.id} ` +
        `(disponíveis: ${def.models.join(', ')})`,
    );
  }
  return resolved;
}

/**
 * Resolve where the generated file lands. Every path, including absolute
 * paths, must remain inside baseDir after realpath/symlink resolution.
 */
export function resolveOutPath(
  outPath: string | undefined,
  baseDir: string,
  ext: string,
  now: () => number = Date.now,
): string {
  const requested = outPath ?? `generated-${now()}.${ext}`;
  return resolveMediaOutputPath(requested, baseDir);
}

export function listMediaProviders(
  hasKeyFn: (def: MediaProviderDef) => boolean,
  maskedKeyFn: (id: MediaProviderId) => string | null,
): MediaProviderInfo[] {
  return MEDIA_PROVIDERS.map((def) => ({
    id: def.id,
    kind: def.kind,
    label: def.label,
    envVar: def.envVar,
    defaultModel: def.defaultModel,
    models: def.models,
    hasKey: hasKeyFn(def),
    maskedKey: maskedKeyFn(def.id),
  }));
}
