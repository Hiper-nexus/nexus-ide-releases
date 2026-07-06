/**
 * Media generation contracts shared between main and renderer.
 * Providers are exposed to agents as MCP tools (nexus_image_generate,
 * nexus_video_generate, nexus_audio_generate); keys live in the encrypted
 * vault and NEVER reach the agent — it only receives the generated file path.
 */

export type MediaKind = 'image' | 'video' | 'audio';

export type MediaProviderId =
  | 'google-image'
  | 'openai-image'
  | 'replicate-video'
  | 'elevenlabs';

export interface MediaProviderInfo {
  id: MediaProviderId;
  kind: MediaKind;
  label: string;
  defaultModel: string;
  /** Whitelisted models — requests outside this list are rejected. */
  models: string[];
  hasKey: boolean;
  /** Masked key preview for the settings UI (never the raw key). */
  maskedKey: string | null;
}

export interface MediaGenerationResult {
  ok: true;
  /** Absolute path of the generated file inside the workspace. */
  path: string;
  provider: MediaProviderId;
  model: string;
  kind: MediaKind;
  /** Rough cost estimate in USD; null when the provider price is unknown. */
  estimatedCostUsd: number | null;
  durationMs: number;
}

export interface MediaUsageTotals {
  generations: number;
  costUsd: number;
}

export const MEDIA_CHANNELS = {
  listProviders: 'media:listProviders',
  setKey: 'media:setKey',
  usageTotals: 'media:usageTotals',
} as const;
