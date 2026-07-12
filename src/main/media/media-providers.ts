import type {
  MediaKind,
  MediaProviderId,
  MediaProviderInfo,
} from '../../shared/media-types';
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
  estimateCost(params: { model: string; chars?: number; seconds?: number }): number | null;
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
    id: 'replicate-video',
    kind: 'video',
    // Flagship path is Seedance 2.0 (ByteDance multimodal + native audio).
    // Veo 3.1 / Kling / Hailuo share the same Replicate token + poller.
    label: 'Replicate — vídeo (Seedance / Veo / Kling)',
    envVar: 'REPLICATE_API_TOKEN',
    defaultModel: 'bytedance/seedance-2.0',
    models: [
      // ByteDance Seedance 2.x — multimodal refs + last frame + native audio.
      // (There is no public "Seedance 5"; 2.0 is the current flagship.)
      'bytedance/seedance-2.0',
      'bytedance/seedance-2.0-fast',
      'bytedance/seedance-2.0-mini',
      // Google Veo 3.1 family via Replicate.
      'google/veo-3.1',
      'google/veo-3.1-fast',
      'google/veo-3.1-lite',
      // Kling — live Replicate slugs (verified; bare kling-v3 404s).
      'kwaivgi/kling-v3-video',
      'kwaivgi/kling-v3-omni-video',
      'kwaivgi/kling-v2.5-turbo-pro',
      'kwaivgi/kling-v2.1',
      // Minimax + Wan (i2v field differs — see media-generation adapters).
      'minimax/hailuo-2.3',
      'wan-video/wan-2.5-i2v',
    ],
    // Vídeo varia demais por modelo/resolução/duração — sem estimativa falsa.
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
      typeof chars === 'number' ? Number(((chars / 1_000) * 0.18).toFixed(4)) : null,
  },
];

export function findMediaProvider(id: string): MediaProviderDef | null {
  return MEDIA_PROVIDERS.find((p) => p.id === id) ?? null;
}

/**
 * Pick the provider for a request. Explicit provider: must exist, match the
 * kind and have a key — otherwise error (never silently substitute). No
 * provider: cheapest provider of the kind WITH a key (cost routing — table
 * order is already cheapest-first per kind).
 */
export function resolveMediaProvider(
  kind: MediaKind,
  requested: string | undefined,
  hasKeyFn: (def: MediaProviderDef) => boolean,
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
  if (!def.models.includes(requested)) {
    throw new Error(
      `modelo ${requested} não habilitado para ${def.id} ` +
        `(disponíveis: ${def.models.join(', ')})`,
    );
  }
  return requested;
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
