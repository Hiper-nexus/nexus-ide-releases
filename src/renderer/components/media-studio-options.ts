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
  modelPicksVideoDuration,
  videoCostPerSecondUsd,
  videoModelSpec,
  type VideoModelSpec,
} from '../../shared/media-video-models';

export type StudioKind = 'image' | 'video';

export const IMAGE_ASPECTS: readonly string[] = ['1:1', '16:9', '9:16', '4:3', '3:4'];

/**
 * Por que o modelo não gera pelo Estúdio; `null` quando gera. Modelo que
 * pede imagem inicial gera, sim — com uma imagem nas Referências (F-1611).
 */
export function studioModelBlock(model: string, now: number = Date.now()): string | null {
  const spec = videoModelSpec(model);
  if (!spec) return null;
  if (isVideoModelRetired(spec, now)) {
    return `desligado em ${formatRetirementDay(spec.retiresOn ?? '')}`;
  }
  return null;
}

/** Image-to-video: sem uma imagem escolhida nas Referências o serviço recusa. */
export function studioNeedsImage(model: string): boolean {
  return videoModelSpec(model)?.requiresImage === true;
}

/** Primeiro modelo que gera, começando pelo padrão de cada serviço conectado. */
export function firstUsableModel(
  keyed: readonly MediaProviderInfo[],
  now: number = Date.now(),
): { providerId: string; model: string } | null {
  for (const provider of keyed) {
    const ordered = [provider.defaultModel, ...provider.models.filter((m) => m !== provider.defaultModel)];
    // O padrão nunca é um modelo que só anda com imagem: quem abre o Estúdio
    // pela primeira vez precisa conseguir gerar só com o texto.
    const model = ordered.find(
      (m) => provider.models.includes(m) && studioModelBlock(m, now) === null && !studioNeedsImage(m),
    );
    if (model) return { providerId: provider.id, model };
  }
  return null;
}

export interface StudioVideoChoices {
  readonly spec: VideoModelSpec | null;
  readonly aspects: readonly string[];
  readonly resolutions: readonly string[];
  /** Vazio quando o modelo decide a duração (Gemini Omni, F-1587). */
  readonly durations: readonly number[];
  /** Valores efetivos: o escolhido se o modelo aceita, senão o padrão dele. */
  readonly aspect?: string;
  readonly resolution?: string;
  /** Ausente quando o modelo decide: o pedido não leva duração. */
  readonly duration?: number;
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
  const duration = modelPicksVideoDuration(spec)
    ? undefined
    : durations.includes(picked.duration)
      ? picked.duration
      : spec.defaultDuration !== undefined && durations.includes(spec.defaultDuration)
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

/**
 * Preço de lista por segundo quando é o modelo que decide a duração: antes
 * de gerar não há total, só a taxa (o total vem da duração do arquivo).
 */
export function studioVideoPerSecondUsd(
  model: string,
  video?: Pick<StudioVideoChoices, 'spec' | 'resolution'>,
): number | null {
  if (!video?.spec || !modelPicksVideoDuration(video.spec)) return null;
  return videoCostPerSecondUsd(model, video.resolution);
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

/** Seedream recebe várias imagens; os outros serviços de imagem editam uma. */
const IMAGE_MULTI_REFERENCE: Readonly<Record<string, number>> = { 'replicate-image': 10 };

export interface StudioReferencePlan {
  /** Quantas imagens do projeto podem ir para este modelo. */
  readonly max: number;
  /** O papel da 1ª e das demais, numa frase. */
  readonly hint: string;
}

/**
 * F-1611: o que as Referências viram em cada modelo. Vídeo: 1 imagem é o
 * primeiro quadro; 2 ou mais viram referência (personagem, produto, logo,
 * estilo) — o Seedance recusa misturar os dois, então o Estúdio nunca mistura.
 */
export function studioReferencePlan(
  kind: StudioKind,
  providerId: string,
  model: string,
): StudioReferencePlan {
  if (kind === 'image') {
    const multi = IMAGE_MULTI_REFERENCE[providerId];
    return multi
      ? {
          max: multi,
          hint: `A 1ª imagem é a base; as outras (até ${multi}) entram como referência de pessoa, produto, logo ou estilo.`,
        }
      : {
          max: 1,
          hint: 'A imagem escolhida é editada pelo modelo: trocar o fundo, aplicar o logo, mudar o estilo.',
        };
  }
  const refs = videoModelSpec(model)?.maxReferenceImages ?? 0;
  if (refs > 1) {
    return {
      max: refs,
      hint: `1 imagem vira o primeiro quadro do vídeo. 2 ou mais (até ${refs}) viram referência de personagem, produto, logo ou estilo.`,
    };
  }
  return { max: 1, hint: 'A imagem escolhida vira o primeiro quadro do vídeo.' };
}

/** Os campos do pedido a partir da seleção, na ordem em que a pessoa escolheu. */
export function studioReferenceRequest(
  kind: StudioKind,
  selected: readonly string[],
): { imagePath?: string; referenceImagePaths?: string[] } {
  if (selected.length === 0) return {};
  if (kind === 'video' && selected.length > 1) return { referenceImagePaths: [...selected] };
  const [first, ...rest] = selected;
  return { imagePath: first, ...(rest.length > 0 ? { referenceImagePaths: rest } : {}) };
}
