/**
 * Opções do Estúdio de Mídia por modelo (F-1585): o que o modelo de vídeo
 * escolhido aceita (durações, resoluções, proporções), o que ele não faz pelo
 * Estúdio (precisa de imagem inicial, desligado pelo fornecedor) e o custo de
 * lista antes de gerar. Puro; a tabela é `shared/media-video-models`.
 */

import type { MediaProviderInfo } from '../../shared/media-types';
import {
  allowedVideoDurations,
  estimateVideoCostUsd,
  formatRetirementDay,
  isVideoModelRetired,
  videoModelSpec,
  type VideoModelSpec,
} from '../../shared/media-video-models';

export type StudioKind = 'image' | 'video';

export const IMAGE_ASPECTS: readonly string[] = ['1:1', '16:9', '9:16', '4:3', '3:4'];

/** Por que o modelo não gera pelo Estúdio; `null` quando gera. */
export function studioModelBlock(model: string, now: number = Date.now()): string | null {
  const spec = videoModelSpec(model);
  if (!spec) return null;
  if (isVideoModelRetired(spec, now)) {
    return `desligado em ${formatRetirementDay(spec.retiresOn ?? '')}`;
  }
  if (spec.requiresImage) return 'precisa de imagem inicial (peça a um agente)';
  return null;
}

/** Primeiro modelo que gera, começando pelo padrão de cada serviço conectado. */
export function firstUsableModel(
  keyed: readonly MediaProviderInfo[],
  now: number = Date.now(),
): { providerId: string; model: string } | null {
  for (const provider of keyed) {
    const ordered = [provider.defaultModel, ...provider.models.filter((m) => m !== provider.defaultModel)];
    const model = ordered.find((m) => provider.models.includes(m) && studioModelBlock(m, now) === null);
    if (model) return { providerId: provider.id, model };
  }
  return null;
}

export interface StudioVideoChoices {
  readonly spec: VideoModelSpec | null;
  readonly aspects: readonly string[];
  readonly resolutions: readonly string[];
  readonly durations: readonly number[];
  /** Valores efetivos: o escolhido se o modelo aceita, senão o padrão dele. */
  readonly aspect?: string;
  readonly resolution?: string;
  readonly duration: number;
}

/**
 * Corrige a escolha anterior para o que o modelo aceita. Modelo fora da
 * tabela mantém as opções genéricas de antes.
 */
export function studioVideoChoices(
  model: string,
  picked: { aspect: string; resolution: string; duration: number },
): StudioVideoChoices {
  const spec = videoModelSpec(model);
  if (!spec) {
    return {
      spec: null,
      aspects: ['16:9', '9:16'],
      resolutions: ['720p', '1080p'],
      durations: [4, 5, 6, 8, 10],
      aspect: ['16:9', '9:16'].includes(picked.aspect) ? picked.aspect : '16:9',
      resolution: ['720p', '1080p'].includes(picked.resolution) ? picked.resolution : '720p',
      duration: picked.duration,
    };
  }
  const resolution =
    spec.resolutions.length === 0
      ? undefined
      : spec.resolutions.includes(picked.resolution)
        ? picked.resolution
        : spec.defaultResolution;
  const durations = allowedVideoDurations(spec, { resolution });
  const duration = durations.includes(picked.duration)
    ? picked.duration
    : durations.includes(spec.defaultDuration)
      ? spec.defaultDuration
      : (durations.at(-1) ?? spec.defaultDuration);
  const aspect =
    spec.aspectRatios.length === 0
      ? undefined
      : spec.aspectRatios.includes(picked.aspect)
        ? picked.aspect
        : spec.aspectRatios[0];
  return {
    spec,
    aspects: spec.aspectRatios,
    resolutions: spec.resolutions,
    durations,
    aspect,
    resolution,
    duration,
  };
}

/** Aviso de desligamento marcado e ainda não alcançado. */
export function studioRetirementNotice(model: string, now: number = Date.now()): string | null {
  const spec = videoModelSpec(model);
  if (!spec?.retiresOn || isVideoModelRetired(spec, now)) return null;
  const after = spec.replacement ? ` Depois disso, use ${spec.replacement}.` : '';
  return `O fornecedor desliga este modelo em ${formatRetirementDay(spec.retiresOn)}.${after}`;
}

/** Custo de lista antes de gerar; `null` quando não há preço conhecido. */
export function studioCostUsd(
  kind: StudioKind,
  provider: MediaProviderInfo | undefined,
  model: string,
  video?: Pick<StudioVideoChoices, 'duration' | 'resolution'>,
): number | null {
  if (kind === 'image') return provider?.imageCostUsd?.[model] ?? null;
  return estimateVideoCostUsd(model, {
    seconds: video?.duration,
    resolution: video?.resolution,
  });
}
