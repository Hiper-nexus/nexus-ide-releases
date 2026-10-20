/**
 * Media generation contracts shared between main and renderer.
 * Providers are exposed to agents as MCP tools (nexus_image_generate,
 * nexus_video_generate, nexus_audio_generate); keys live in the encrypted
 * vault and NEVER reach the agent — it only receives the generated file path.
 */

import type { VideoModelCard } from './media-video-models';

export type MediaKind = 'image' | 'video' | 'audio';

/**
 * Single source of truth for provider ids — the zod enum in media-ipc.ts and
 * the MediaProviderId type both derive from this list, so adding a provider
 * touches exactly one place.
 */
export const MEDIA_PROVIDER_IDS = [
  'google-image',
  'openai-image',
  'replicate-image',
  'replicate-video',
  'google-video',
  'elevenlabs',
  // F-1599: Grok Imagine (xAI), com a XAI_API_KEY da voz do Grok.
  'xai-image',
  'xai-video',
] as const;

export type MediaProviderId = (typeof MEDIA_PROVIDER_IDS)[number];

export interface MediaProviderInfo {
  id: MediaProviderId;
  kind: MediaKind;
  label: string;
  /** Env var shape the provider expects, shown only as a non-secret hint. */
  envVar: string;
  defaultModel: string;
  /** Whitelisted models — requests outside this list are rejected. */
  models: string[];
  hasKey: boolean;
  /** Masked key preview for the settings UI (never the raw key). */
  maskedKey: string | null;
  /**
   * F-1585: preço de lista por imagem, em USD, por modelo (só imagem; o de
   * vídeo depende de duração e resolução e vem de `media-video-models`).
   */
  imageCostUsd?: Record<string, number | null>;
  /**
   * F-1598: o cartão de cada modelo de vídeo (durações ou «o modelo decide»,
   * resoluções, proporções, imagem obrigatória, preço de lista, desligamento),
   * para o agente escolher sem tentar e ser recusado. Só vídeo.
   */
  videoModels?: Record<string, VideoModelCard | null>;
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
  /** Long-running video job id (resume with recoverJobId on timeout). */
  jobId?: string;
  /**
   * F-1587: duração lida do MP4 gerado, em segundos, quando é o modelo que
   * decide (Gemini Omni). O custo estimado usa este número.
   */
  videoDurationSeconds?: number;
}

export interface MediaUsageTotals {
  generations: number;
  costUsd: number;
}

/** A recorded generation, newest first — powers the Estúdio gallery. */
export interface MediaArtifactInfo {
  id: string;
  kind: MediaKind;
  provider: string;
  model: string;
  /** Project-relative POSIX path of the generated file. */
  storageKey: string;
  costUsd: number | null;
  durationMs: number;
  createdAt: number;
}

/**
 * Estúdio de Mídia (renderer) → main. Prompt-driven generation for layman
 * users: the panel picks friendly defaults; everything lands in the open
 * workspace and is accounted like agent-driven generations.
 */
export interface MediaStudioRequest {
  kind: 'image' | 'video';
  prompt: string;
  providerId?: MediaProviderId;
  model?: string;
  aspectRatio?: string;
  /** Seedream image size: 1K | 2K. */
  size?: string;
  /** Video only. */
  durationSeconds?: number;
  resolution?: string;
  /** Workspace image for image-to-image / first-frame (optional). */
  imagePath?: string;
  /** Video only: resume a timed-out job without paying twice. */
  recoverJobId?: string;
  /** Renderer-generated id so media:cancelGenerate can abort the wait. */
  clientJobId: string;
}

/**
 * F-1584: que tipo de falha o serviço devolveu — o Estúdio oferece a saída
 * certa (ex.: abrir Serviços de mídia quando a chave foi recusada).
 */
export type MediaErrorKind =
  | 'key'
  | 'billing'
  | 'not-found'
  | 'rate-limit'
  | 'unavailable'
  | 'invalid-request';

export type MediaStudioResponse =
  /**
   * F-1586: `artifactId` é a linha da galeria gravada para ESTE resultado —
   * a prévia mostra o arquivo gerado, não "o mais novo do mesmo tipo".
   */
  | (MediaGenerationResult & { artifactId?: string })
  | {
      ok: false;
      error: string;
      errorKind?: MediaErrorKind;
      recoverJobId?: string;
      canceled?: boolean;
    };

/**
 * F-1589: geração, galeria e totais vivem na pasta do projeto aberto; chaves
 * e provedores são globais. Sem projeto, o Main responde com esta frase (ou
 * `null` nas leituras) em vez de lançar a recusa crua de escopo.
 */
export const MEDIA_NO_PROJECT_ERROR =
  'Abra um projeto para gerar: as imagens e os vídeos são salvos na pasta do projeto aberto.';

export const MEDIA_CHANNELS = {
  listProviders: 'media:listProviders',
  setKey: 'media:setKey',
  usageTotals: 'media:usageTotals',
  generate: 'media:generate',
  cancelGenerate: 'media:cancelGenerate',
  listArtifacts: 'media:listArtifacts',
  revealArtifact: 'media:revealArtifact',
  readArtifactDataUrl: 'media:readArtifactDataUrl',
} as const;
