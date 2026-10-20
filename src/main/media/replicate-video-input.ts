import { videoModelSpec } from '../../shared/media-video-models';
import type { MediaInputFile } from './media-path-policy';
import { dataUri } from './media-runtime';
import type { VideoRequest } from './media-generation';

/**
 * O `input` de uma predição de vídeo no Replicate, por família de modelo.
 * Saiu de `media-generation.ts` (teto de linhas do oxlint) quando entraram
 * os modelos de 2026-08/09 (F-1612); o motor reexporta as mesmas funções.
 *
 * Cada família tem os próprios nomes de campo — mandar o errado faz o
 * serviço ignorar o quadro em silêncio. Conferido no schema público de cada
 * modelo (`replicate.com/<dono>/<modelo>/api/schema`) em 20/10/2026.
 */

/**
 * Image-to-video input FIELD NAME differs by Replicate model family. Passing
 * the wrong one drops the first frame silently. Verified against live OpenAPI
 * schemas (2026-07, 2026-10) and the peer ADE mediaGeneration adapter.
 */
export function replicateImageField(model: string): string {
  if (model.startsWith('kwaivgi/kling')) return 'start_image';
  if (
    model.startsWith('minimax/hailuo') ||
    model.startsWith('minimax/video-01') ||
    model.startsWith('minimax/h3')
  ) {
    return 'first_frame_image';
  }
  if (model.startsWith('luma/')) return 'start_image';
  if (model.startsWith('vidu/')) return 'start_image';
  if (model.startsWith('openai/sora')) return 'input_reference';
  // seedance, veo, gemini-omni, runway, wan-video, alibaba/wan-3, pixverse, default
  return 'image';
}

/** End / last-frame field when the family supports keyframe interpolation. */
export function replicateEndImageField(model: string): string | null {
  if (model.startsWith('kwaivgi/kling')) return 'end_image';
  if (model.startsWith('bytedance/seedance')) return 'last_frame_image';
  if (model.startsWith('google/veo')) return 'last_frame';
  if (model.startsWith('google/gemini-omni')) return 'last_frame';
  if (model.startsWith('luma/')) return 'end_image';
  if (model.startsWith('minimax/h3')) return 'last_frame_image';
  if (model.startsWith('pixverse/')) return 'last_frame_image';
  if (model.startsWith('vidu/')) return 'end_image';
  return null;
}

const SORA_ASPECTS: Record<string, string> = { '16:9': 'landscape', '9:16': 'portrait' };
const SORA_RESOLUTIONS: Record<string, string> = { '720p': 'standard', '1024p': 'high' };
/** MiniMax H3 fala `768P`/`2K` em maiúsculas; o Nexus fala `768p`/`2k`. */
const H3_RESOLUTIONS: Record<string, string> = { '768p': '768P', '2k': '2K' };

function soraAspect(value: string): string {
  return SORA_ASPECTS[value] ?? value;
}

function soraResolution(value: string): string {
  return SORA_RESOLUTIONS[value] ?? value;
}

/** Quantas imagens de referência o motor manda para o modelo. */
export function replicateReferenceLimit(model: string, fallback: number): number {
  return videoModelSpec(model)?.maxReferenceImages ?? fallback;
}

/**
 * Build the Replicate prediction `input` for the requested model.
 */
export function replicateInput(
  req: VideoRequest,
  model: string,
  image?: MediaInputFile,
  endImage?: MediaInputFile,
  referenceImages: MediaInputFile[] = [],
  openaiApiKey?: string,
): Record<string, unknown> {
  const isSeedance = model.startsWith('bytedance/seedance');
  const isVeo = model.startsWith('google/veo');
  const isOmni = model.startsWith('google/gemini-omni');
  const isKling = model.startsWith('kwaivgi/kling');
  const isHailuo = model.startsWith('minimax/hailuo');
  const isH3 = model.startsWith('minimax/h3');
  const isWan3 = model.startsWith('alibaba/wan-3');
  const isPixverse = model.startsWith('pixverse/');
  const isVidu = model.startsWith('vidu/');
  const isSora = model.startsWith('openai/sora');
  const isRunway = model.startsWith('runwayml/');
  const isLuma = model.startsWith('luma/');
  const isWan = model.startsWith('wan-video/');
  const hasFrame = Boolean(image || endImage);

  const input: Record<string, unknown> = { prompt: req.prompt };

  const spec = videoModelSpec(model);
  if (isSeedance || isVeo) {
    input.duration = req.durationSeconds ?? spec?.defaultDuration ?? 5;
    input.resolution = req.resolution ?? spec?.defaultResolution ?? '720p';
    input.aspect_ratio = req.aspectRatio ?? '16:9';
    // Seedance 2.5: primeiro/último quadro exige `adaptive` (a saída segue a imagem).
    if (model.startsWith('bytedance/seedance-2.5') && hasFrame) input.aspect_ratio = 'adaptive';
    if (!(isVeo && model.endsWith('-lite'))) {
      input.generate_audio = true;
    }
  } else if (isOmni) {
    // Gemini Omni decide a duração: o schema não tem o campo.
    input.resolution = req.resolution ?? spec?.defaultResolution ?? '720p';
    if (req.aspectRatio) input.aspect_ratio = req.aspectRatio;
  } else if (isH3) {
    input.duration = req.durationSeconds ?? spec?.defaultDuration ?? 5;
    const resolution = req.resolution ?? spec?.defaultResolution;
    if (resolution) input.resolution = H3_RESOLUTIONS[resolution] ?? resolution.toUpperCase();
    // O campo é `ratio`; com imagem inicial o schema pede `adaptive`.
    input.ratio = hasFrame ? 'adaptive' : (req.aspectRatio ?? '16:9');
  } else if (isWan3) {
    input.duration = req.durationSeconds ?? spec?.defaultDuration ?? 5;
    input.resolution = req.resolution ?? spec?.defaultResolution ?? '1080p';
    if (!image && req.aspectRatio) input.aspect_ratio = req.aspectRatio;
  } else if (isPixverse) {
    input.duration = req.durationSeconds ?? spec?.defaultDuration ?? 5;
    // A resolução do PixVerse se chama `quality`.
    input.quality = req.resolution ?? spec?.defaultResolution ?? '540p';
    if (!hasFrame && req.aspectRatio) input.aspect_ratio = req.aspectRatio;
    input.generate_audio_switch = true;
  } else if (isVidu) {
    input.duration = req.durationSeconds ?? spec?.defaultDuration ?? 5;
    input.resolution = req.resolution ?? spec?.defaultResolution ?? '720p';
    if (!hasFrame && req.aspectRatio) input.aspect_ratio = req.aspectRatio;
    input.audio = true;
  } else if (isKling) {
    if (req.durationSeconds !== undefined) input.duration = req.durationSeconds;
    if (req.aspectRatio) input.aspect_ratio = req.aspectRatio;
    if (req.resolution === '720p') input.mode = 'standard';
    else if (req.resolution === '1080p') input.mode = 'pro';
    else if (req.resolution === '4k') input.mode = '4k';
  } else if (isHailuo || isWan) {
    if (req.durationSeconds !== undefined) input.duration = req.durationSeconds;
    if (req.resolution) input.resolution = req.resolution;
  } else if (isSora) {
    // Sora uses `seconds` not duration; may require the caller's OpenAI key.
    // F-1585: o schema do Sora só aceita aspect_ratio portrait|landscape e,
    // no Pro, resolution standard|high — o Nexus fala 16:9/9:16 e 720p/1024p.
    input.seconds = req.durationSeconds ?? 4;
    if (req.aspectRatio) input.aspect_ratio = soraAspect(req.aspectRatio);
    if (req.resolution && model.includes('pro')) {
      input.resolution = soraResolution(req.resolution);
    }
    if (openaiApiKey) input.openai_api_key = openaiApiKey;
  } else if (isRunway) {
    if (req.durationSeconds !== undefined) input.duration = req.durationSeconds;
    if (req.aspectRatio) input.aspect_ratio = req.aspectRatio;
  } else if (isLuma) {
    if (req.durationSeconds !== undefined) input.duration = req.durationSeconds;
    if (req.resolution) input.resolution = req.resolution;
    if (req.aspectRatio) input.aspect_ratio = req.aspectRatio;
  }

  if (image) {
    input[replicateImageField(model)] = dataUri(image);
  }
  if (endImage) {
    const endField = replicateEndImageField(model);
    if (endField) input[endField] = dataUri(endImage);
  }

  // Seedance cannot combine reference_images with first/last frame (OpenAPI).
  if (isSeedance && referenceImages.length > 0 && hasFrame) {
    throw new Error(
      'Seedance: reference_images não pode combinar com imagePath/endImagePath — use um ou outro',
    );
  }
  // Seedance / Veo / Gemini Omni reference images (character consistency).
  if (referenceImages.length > 0 && (isSeedance || isVeo || isOmni)) {
    input.reference_images = referenceImages.map(dataUri);
  }

  return input;
}
