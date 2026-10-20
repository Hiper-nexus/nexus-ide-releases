/**
 * O que cada modelo de vídeo aceita e quanto custa (F-1585). Uma tabela só,
 * lida pelo Main (valida o pedido ANTES de chamar o serviço, aplica o padrão
 * do modelo e estima o custo) e pelo Estúdio (só oferece o que o modelo
 * aceita e mostra o custo antes de gerar).
 *
 * Fontes, conferidas em 19/10/2026: o schema público de cada modelo no
 * Replicate (`replicate.com/<dono>/<modelo>/api/schema`, campos `duration`,
 * `resolution`/`mode`, `aspect_ratio` e o preço de cobrança da página) e a
 * página do Veo na API do Gemini (`ai.google.dev/gemini-api/docs/veo`, tabela
 * de parâmetros) com as datas de `ai.google.dev/gemini-api/docs/deprecations`.
 * Onde o schema não fixa o mínimo (Seedance 2.0 aceita `-1..15`), a tabela
 * oferece só o intervalo seguro (4..15). Preço é o de lista, em USD; quem
 * cobra de verdade é o serviço.
 *
 * Gemini Omni Flash (F-1587): `ai.google.dev/gemini-api/docs/omni` e a
 * referência `ai.google.dev/api/interactions-api` (o `video_config` só tem
 * `task`: não há campo de duração, quem decide é o modelo). Preço por
 * resolução da tabela do anúncio (`blog.google`, «Gemini Omni 1.1 Flash lets
 * you build with more control», 27/08/2026), que bate com a página de preços
 * (`ai.google.dev/gemini-api/docs/pricing`, 16/10/2026: ~$0.10/s em 720p,
 * 5.792 tokens de saída por segundo a $17.50 o milhão).
 *
 * Grok Imagine (xAI, F-1599): `docs.x.ai/developers/model-capabilities/video/
 * overview` (08/10/2026, tabela "Capabilities and specifications": 1–15 s,
 * resolução e proporções por modelo) e `video/generation` (10/10/2026: padrão
 * 8 s; com imagem inicial a saída segue a proporção dela). Preço por segundo
 * e resolução da tabela "Imagine API" de `docs.x.ai/developers/pricing`
 * (10/10/2026); a imagem de entrada custa à parte (US$ 0,01) e o custo real
 * vem do `usage.cost_in_usd_ticks` da resposta.
 *
 * Resolução usa o vocabulário do Nexus (`720p`, `1080p`, `4k`…); a tradução
 * para o campo do modelo (Kling `mode`, Sora `standard`/`high`) mora no motor.
 */

export type VideoPricing =
  | { readonly kind: 'per-second'; readonly usd: Readonly<Record<string, number>> }
  | {
      readonly kind: 'per-video';
      /** resolução → segundos → USD do vídeo inteiro. */
      readonly usd: Readonly<Record<string, Readonly<Record<number, number>>>>;
    };

export interface VideoModelSpec {
  /**
   * Durações aceitas, em segundos, em ordem crescente. Vazio = o modelo
   * decide a duração e o pedido não leva duração (Gemini Omni); o custo sai
   * da duração do arquivo gerado.
   */
  readonly durations: readonly number[];
  /** Ausente quando `durations` é vazio. */
  readonly defaultDuration?: number;
  /** Resoluções aceitas; vazio = o modelo não deixa escolher. */
  readonly resolutions: readonly string[];
  readonly defaultResolution?: string;
  /** Resolução que só aceita algumas durações (Veo 1080p/4k só 8 s). */
  readonly durationsByResolution?: Readonly<Record<string, readonly number[]>>;
  /** Proporções aceitas; vazio = segue a imagem inicial ou é fixa. */
  readonly aspectRatios: readonly string[];
  /** Image-to-video: sem imagem inicial o serviço recusa. */
  readonly requiresImage?: boolean;
  /** Durações aceitas quando há imagem inicial (Ray 3.2: 10 s só sem imagem). */
  readonly durationsWithImage?: readonly number[];
  /** Preço com a 1ª resolução como chave curinga `*` quando não varia. */
  readonly pricing: VideoPricing;
  /**
   * Cobrança por token (Gemini Omni): `pricing` é a tabela por segundo do
   * anúncio, aproximada; o custo real sai do `usage` da resposta.
   */
  readonly tokenPricingUsdPerMillion?: GeminiOmniTokenPricing;
  /**
   * Cada imagem de entrada (inicial, final, referência) cobrada à parte
   * (Grok Imagine: «Image» em INPUT PRICING de cada modelo em docs.x.ai,
   * lido em 19/10/2026; revisão do PR #145).
   */
  readonly inputImageUsd?: number;
  /** Dia (AAAA-MM-DD, UTC) em que o fornecedor desliga o modelo. */
  readonly retiresOn?: string;
  /** Modelo que segue funcionando, para a frase de desligamento. */
  readonly replacement?: string;
}

const range = (from: number, to: number): number[] =>
  Array.from({ length: to - from + 1 }, (_, index) => from + index);

const SEEDANCE_ASPECTS = ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9', '9:21'] as const;
const VEO_ASPECTS = ['16:9', '9:16'] as const;
const KLING_ASPECTS = ['16:9', '9:16', '1:1'] as const;
const XAI_VIDEO_ASPECTS = ['16:9', '9:16', '1:1', '4:3', '3:4', '3:2', '2:3', '21:9', '5:2'] as const;
const GEMINI_VEO_RETIREMENT = {
  retiresOn: '2026-10-22',
  replacement: 'gemini-omni-1.1-flash, com a mesma chave do Gemini',
} as const;

/** US$ por milhão de tokens do Gemini Omni (ver `geminiOmniCostUsd`). */
export interface GeminiOmniTokenPricing {
  readonly input: number;
  /** Texto de saída, raciocínio incluído. */
  readonly textOutput: number;
  readonly videoOutput: number;
}

export const GEMINI_OMNI_TOKEN_USD_PER_MILLION: GeminiOmniTokenPricing = Object.freeze({
  input: 1.5,
  textOutput: 9,
  videoOutput: 17.5,
});

export const VIDEO_MODEL_SPECS: Readonly<Record<string, VideoModelSpec>> = Object.freeze({
  'bytedance/seedance-2.0': {
    durations: range(4, 15),
    defaultDuration: 5,
    resolutions: ['480p', '720p', '1080p', '4k'],
    defaultResolution: '720p',
    aspectRatios: SEEDANCE_ASPECTS,
    pricing: { kind: 'per-second', usd: { '480p': 0.08, '720p': 0.18, '1080p': 0.45, '4k': 1 } },
  },
  'bytedance/seedance-2.0-fast': {
    durations: range(4, 15),
    defaultDuration: 5,
    resolutions: ['480p', '720p'],
    defaultResolution: '720p',
    aspectRatios: SEEDANCE_ASPECTS,
    pricing: { kind: 'per-second', usd: { '480p': 0.07, '720p': 0.15 } },
  },
  'bytedance/seedance-2.0-mini': {
    durations: range(4, 15),
    defaultDuration: 5,
    resolutions: ['480p', '720p'],
    defaultResolution: '720p',
    aspectRatios: SEEDANCE_ASPECTS,
    pricing: { kind: 'per-second', usd: { '480p': 0.04, '720p': 0.09 } },
  },
  'google/veo-3.1': {
    durations: [4, 6, 8],
    defaultDuration: 8,
    resolutions: ['720p', '1080p'],
    defaultResolution: '720p',
    durationsByResolution: { '1080p': [8] },
    aspectRatios: VEO_ASPECTS,
    // Com áudio (o motor liga `generate_audio`).
    pricing: { kind: 'per-second', usd: { '*': 0.4 } },
  },
  'google/veo-3.1-fast': {
    durations: [4, 6, 8],
    defaultDuration: 8,
    resolutions: ['720p', '1080p'],
    defaultResolution: '720p',
    durationsByResolution: { '1080p': [8] },
    aspectRatios: VEO_ASPECTS,
    pricing: { kind: 'per-second', usd: { '*': 0.15 } },
  },
  'google/veo-3.1-lite': {
    durations: [4, 6, 8],
    defaultDuration: 8,
    resolutions: ['720p', '1080p'],
    defaultResolution: '720p',
    durationsByResolution: { '1080p': [8] },
    aspectRatios: VEO_ASPECTS,
    pricing: { kind: 'per-second', usd: { '720p': 0.05, '1080p': 0.08 } },
  },
  'kwaivgi/kling-v3-video': {
    durations: range(3, 15),
    defaultDuration: 5,
    resolutions: ['720p', '1080p', '4k'],
    defaultResolution: '1080p',
    aspectRatios: KLING_ASPECTS,
    pricing: { kind: 'per-second', usd: { '720p': 0.168, '1080p': 0.224, '4k': 0.42 } },
  },
  'kwaivgi/kling-v3-omni-video': {
    durations: range(3, 15),
    defaultDuration: 5,
    resolutions: ['720p', '1080p', '4k'],
    defaultResolution: '1080p',
    aspectRatios: KLING_ASPECTS,
    pricing: { kind: 'per-second', usd: { '720p': 0.168, '1080p': 0.224, '4k': 0.42 } },
  },
  'kwaivgi/kling-v2.5-turbo-pro': {
    durations: [5, 10],
    defaultDuration: 5,
    resolutions: [],
    aspectRatios: KLING_ASPECTS,
    pricing: { kind: 'per-second', usd: { '*': 0.07 } },
  },
  'kwaivgi/kling-v2.1': {
    durations: [5, 10],
    defaultDuration: 5,
    resolutions: ['720p', '1080p'],
    defaultResolution: '720p',
    aspectRatios: [],
    requiresImage: true,
    pricing: { kind: 'per-second', usd: { '720p': 0.05, '1080p': 0.09 } },
  },
  'minimax/hailuo-2.3': {
    durations: [6, 10],
    defaultDuration: 6,
    resolutions: ['768p', '1080p'],
    defaultResolution: '768p',
    durationsByResolution: { '1080p': [6] },
    aspectRatios: [],
    pricing: { kind: 'per-video', usd: { '768p': { 6: 0.28, 10: 0.56 }, '1080p': { 6: 0.49 } } },
  },
  'wan-video/wan-2.5-i2v': {
    durations: [5, 10],
    defaultDuration: 5,
    resolutions: ['480p', '720p', '1080p'],
    defaultResolution: '720p',
    aspectRatios: [],
    requiresImage: true,
    pricing: { kind: 'per-second', usd: { '480p': 0.05, '720p': 0.1, '1080p': 0.15 } },
  },
  'openai/sora-2': {
    durations: [4, 8, 12],
    defaultDuration: 4,
    resolutions: [],
    aspectRatios: VEO_ASPECTS,
    pricing: { kind: 'per-second', usd: { '*': 0.1 } },
  },
  'openai/sora-2-pro': {
    durations: [4, 8, 12],
    defaultDuration: 4,
    resolutions: ['720p', '1024p'],
    defaultResolution: '720p',
    aspectRatios: VEO_ASPECTS,
    pricing: { kind: 'per-second', usd: { '720p': 0.3, '1024p': 0.5 } },
  },
  'runwayml/gen-4.5': {
    durations: [5, 10],
    defaultDuration: 5,
    resolutions: [],
    aspectRatios: ['16:9', '9:16', '4:3', '3:4', '1:1', '21:9'],
    pricing: { kind: 'per-second', usd: { '*': 0.12 } },
  },
  'luma/ray-3.2': {
    durations: [5, 10],
    defaultDuration: 5,
    durationsWithImage: [5],
    resolutions: ['540p', '720p', '1080p'],
    defaultResolution: '720p',
    aspectRatios: ['16:9', '9:16', '4:3', '3:4', '1:1', '21:9'],
    pricing: {
      kind: 'per-video',
      usd: { '540p': { 5: 0.15, 10: 0.45 }, '720p': { 5: 0.3, 10: 0.9 }, '1080p': { 5: 1.2, 10: 3.6 } },
    },
  },
  'gemini-omni-1.1-flash': {
    durations: [],
    // 1080p e 4k são ampliados pelo próprio serviço a partir do 720p.
    resolutions: ['360p', '720p', '1080p', '4k'],
    defaultResolution: '720p',
    aspectRatios: VEO_ASPECTS,
    pricing: { kind: 'per-second', usd: { '360p': 0.03, '720p': 0.1, '1080p': 0.15, '4k': 0.3 } },
    tokenPricingUsdPerMillion: GEMINI_OMNI_TOKEN_USD_PER_MILLION,
  },
  'veo-3.1-generate-preview': {
    durations: [4, 6, 8],
    defaultDuration: 8,
    resolutions: ['720p', '1080p', '4k'],
    defaultResolution: '720p',
    durationsByResolution: { '1080p': [8], '4k': [8] },
    aspectRatios: VEO_ASPECTS,
    pricing: { kind: 'per-second', usd: { '720p': 0.4, '1080p': 0.4, '4k': 0.6 } },
    ...GEMINI_VEO_RETIREMENT,
  },
  'veo-3.1-fast-generate-preview': {
    durations: [4, 6, 8],
    defaultDuration: 8,
    resolutions: ['720p', '1080p', '4k'],
    defaultResolution: '720p',
    durationsByResolution: { '1080p': [8], '4k': [8] },
    aspectRatios: VEO_ASPECTS,
    pricing: { kind: 'per-second', usd: { '720p': 0.1, '1080p': 0.12, '4k': 0.3 } },
    ...GEMINI_VEO_RETIREMENT,
  },
  'veo-3.1-lite-generate-preview': {
    durations: [4, 6, 8],
    defaultDuration: 8,
    resolutions: ['720p', '1080p'],
    defaultResolution: '720p',
    durationsByResolution: { '1080p': [8] },
    aspectRatios: VEO_ASPECTS,
    pricing: { kind: 'per-second', usd: { '720p': 0.05, '1080p': 0.08 } },
    ...GEMINI_VEO_RETIREMENT,
  },
  'grok-imagine-video-1.5': {
    durations: range(1, 15),
    defaultDuration: 8,
    // 1080p nativo; com referências ou último quadro vai até 720p
    // (`xai-imagine.ts` recusa antes de pagar).
    resolutions: ['480p', '720p', '1080p'],
    defaultResolution: '720p',
    aspectRatios: XAI_VIDEO_ASPECTS,
    pricing: { kind: 'per-second', usd: { '480p': 0.08, '720p': 0.14, '1080p': 0.25 } },
    inputImageUsd: 0.01,
  },
  'grok-imagine-video-1.5-lite': {
    durations: range(1, 15),
    defaultDuration: 8,
    // 1080p é o 720p ampliado pela própria xAI.
    resolutions: ['480p', '720p', '1080p'],
    defaultResolution: '720p',
    aspectRatios: XAI_VIDEO_ASPECTS,
    pricing: { kind: 'per-second', usd: { '480p': 0.02, '720p': 0.03, '1080p': 0.14 } },
    inputImageUsd: 0.01,
  },
  'grok-imagine-video': {
    durations: range(1, 15),
    defaultDuration: 8,
    resolutions: ['480p', '720p'],
    defaultResolution: '720p',
    aspectRatios: XAI_VIDEO_ASPECTS,
    pricing: { kind: 'per-second', usd: { '480p': 0.05, '720p': 0.07 } },
    inputImageUsd: 0.002,
  },
});

export function videoModelSpec(model: string): VideoModelSpec | null {
  return VIDEO_MODEL_SPECS[model] ?? null;
}

/** O pedido não leva duração: o modelo decide (Gemini Omni). */
export function modelPicksVideoDuration(spec: VideoModelSpec): boolean {
  return spec.durations.length === 0;
}

/** Durações válidas para a resolução (e a imagem inicial) escolhidas. */
export function allowedVideoDurations(
  spec: VideoModelSpec,
  options: { resolution?: string; hasImage?: boolean } = {},
): number[] {
  let durations = [...spec.durations];
  const byResolution = options.resolution
    ? spec.durationsByResolution?.[options.resolution]
    : undefined;
  if (byResolution) durations = durations.filter((d) => byResolution.includes(d));
  if (options.hasImage && spec.durationsWithImage) {
    const withImage = spec.durationsWithImage;
    durations = durations.filter((d) => withImage.includes(d));
  }
  return durations;
}

/** `true` a partir do dia do desligamento (UTC). */
export function isVideoModelRetired(spec: VideoModelSpec, now: number = Date.now()): boolean {
  if (!spec.retiresOn) return false;
  return now >= Date.parse(`${spec.retiresOn}T00:00:00Z`);
}

/** `2026-10-22` → `22/10/2026`. */
export function formatRetirementDay(day: string): string {
  const [y, m, d] = day.split('-');
  return y && m && d ? `${d}/${m}/${y}` : day;
}

export function retiredVideoModelMessage(model: string, spec: VideoModelSpec): string {
  const replacement = spec.replacement ? `; use ${spec.replacement}` : '';
  return `O fornecedor desligou o ${model} em ${formatRetirementDay(spec.retiresOn ?? '')}${replacement}.`;
}

export interface VideoRequestOptions {
  durationSeconds?: number;
  resolution?: string;
  aspectRatio?: string;
  hasImage?: boolean;
}

/**
 * Frase em pt-BR quando o pedido tem algo que o modelo recusa; `null` quando
 * está tudo certo (ou o modelo não está na tabela — aí o serviço decide).
 * Roda antes de qualquer chamada paga.
 */
export function videoRequestProblem(
  model: string,
  options: VideoRequestOptions,
  now: number = Date.now(),
): string | null {
  const spec = videoModelSpec(model);
  if (!spec) return null;
  if (isVideoModelRetired(spec, now)) return retiredVideoModelMessage(model, spec);
  if (spec.requiresImage && !options.hasImage) {
    return `${model} gera vídeo a partir de uma imagem inicial: informe a imagem (imagePath).`;
  }
  const { resolution, aspectRatio, durationSeconds } = options;
  if (resolution !== undefined) {
    if (spec.resolutions.length === 0) {
      return `${model} não deixa escolher a resolução: tire a resolução do pedido.`;
    }
    if (!spec.resolutions.includes(resolution)) {
      return `${model} aceita resolução ${spec.resolutions.join(', ')} (pedido: ${resolution}).`;
    }
  }
  if (aspectRatio !== undefined) {
    if (spec.aspectRatios.length === 0) {
      return `${model} não deixa escolher a proporção (segue a imagem inicial): tire a proporção do pedido.`;
    }
    if (!spec.aspectRatios.includes(aspectRatio)) {
      return `${model} aceita proporção ${spec.aspectRatios.join(', ')} (pedido: ${aspectRatio}).`;
    }
  }
  if (durationSeconds !== undefined) {
    if (modelPicksVideoDuration(spec)) {
      return `${model} não deixa escolher a duração (o modelo decide): tire a duração do pedido.`;
    }
    const allowed = allowedVideoDurations(spec, {
      resolution: resolution ?? spec.defaultResolution,
      hasImage: options.hasImage,
    });
    if (!allowed.includes(durationSeconds)) {
      const context = resolution ? ` em ${resolution}` : '';
      return `${model} aceita ${allowed.join(', ')} segundos${context} (pedido: ${durationSeconds} s).`;
    }
  }
  return null;
}

/** Tokens que a resposta do Gemini Omni informa em `usage`. */
export interface GeminiOmniUsage {
  readonly inputTokens: number;
  readonly videoTokens: number;
  /** Saída de texto mais o raciocínio (cobrado como saída de texto). */
  readonly textTokens: number;
}

/**
 * O Gemini Omni cobra por token (`ai.google.dev/gemini-api/docs/pricing`,
 * 16/10/2026, Standard pago, por milhão): entrada US$ 1,50; saída «including
 * thinking tokens» US$ 9,00 de texto e US$ 17,50 de vídeo. A tabela por
 * segundo arredonda (360p = 1.930 tokens/s = US$ 0,0338/s, não 0,03): com o
 * `usage` da resposta, o custo é o que o Google cobra.
 */
export function geminiOmniCostUsd(usage: GeminiOmniUsage): number {
  const price = GEMINI_OMNI_TOKEN_USD_PER_MILLION;
  const usd =
    (usage.inputTokens * price.input +
      usage.textTokens * price.textOutput +
      usage.videoTokens * price.videoOutput) /
    1_000_000;
  return Number(usd.toFixed(4));
}

/**
 * Preço de lista por segundo na resolução (ou na padrão); `null` para modelo
 * cobrado por vídeo ou sem preço naquela resolução.
 */
export function videoCostPerSecondUsd(model: string, resolution?: string): number | null {
  const spec = videoModelSpec(model);
  if (!spec || spec.pricing.kind !== 'per-second') return null;
  const key = resolution ?? spec.defaultResolution ?? '*';
  const usd = spec.pricing.usd[key] ?? spec.pricing.usd['*'];
  return typeof usd === 'number' ? usd : null;
}

/**
 * Custo de lista do vídeo em USD; `null` quando a tabela não tem o preço
 * daquela combinação — nunca um chute. Modelo que decide a duração só tem
 * custo com a duração do arquivo gerado (`seconds`).
 */
export function estimateVideoCostUsd(
  model: string,
  options: { seconds?: number; resolution?: string; inputImages?: number },
): number | null {
  const spec = videoModelSpec(model);
  if (!spec) return null;
  const seconds = options.seconds && options.seconds > 0 ? options.seconds : spec.defaultDuration;
  if (seconds === undefined) return null;
  const resolution = options.resolution ?? spec.defaultResolution ?? '*';
  // Imagens de entrada cobradas à parte (Grok Imagine), somadas ao vídeo.
  const inputs = (options.inputImages ?? 0) * (spec.inputImageUsd ?? 0);
  if (spec.pricing.kind === 'per-video') {
    const usd = spec.pricing.usd[resolution]?.[seconds];
    return typeof usd === 'number' ? Number((usd + inputs).toFixed(4)) : null;
  }
  const perSecond = videoCostPerSecondUsd(model, options.resolution);
  return perSecond === null ? null : Number((perSecond * seconds + inputs).toFixed(4));
}

function formatListUsd(usd: number): string {
  return `$${usd < 0.1 ? usd.toFixed(3).replace(/0$/u, '') : usd.toFixed(2)}`;
}

/**
 * Uma linha por modelo para o catálogo (Ajustes → Modelos de mídia):
 * `4, 6, 8 s · 720p, 1080p · $0.40/s`, com o desligamento e a imagem inicial
 * quando for o caso. `null` para modelo fora da tabela.
 */
export function videoModelSummary(model: string, now: number = Date.now()): string | null {
  const spec = videoModelSpec(model);
  if (!spec) return null;
  const parts: string[] = [];
  const durations = spec.durations;
  const contiguous = durations.every((d, i) => i === 0 || d === durations[i - 1]! + 1);
  parts.push(
    modelPicksVideoDuration(spec)
      ? 'duração escolhida pelo modelo'
      : contiguous && durations.length > 3
        ? `${durations[0]}–${durations.at(-1)} s`
        : `${durations.join(', ')} s`,
  );
  if (spec.resolutions.length > 0) parts.push(spec.resolutions.join(', '));
  if (spec.pricing.kind === 'per-second') {
    const prices = Object.values(spec.pricing.usd);
    const min = Math.min(...prices);
    parts.push(`${prices.length > 1 ? 'a partir de ' : ''}${formatListUsd(min)}/s`);
  } else {
    const prices = Object.values(spec.pricing.usd).flatMap((bySeconds) => Object.values(bySeconds));
    parts.push(`a partir de ${formatListUsd(Math.min(...prices))} por vídeo`);
  }
  if (spec.requiresImage) parts.push('precisa de imagem inicial');
  if (spec.retiresOn) {
    parts.push(
      `${isVideoModelRetired(spec, now) ? 'desligado' : 'desliga'} em ${formatRetirementDay(spec.retiresOn)}`,
    );
  }
  return parts.join(' · ');
}

/**
 * Preço de lista do cartão. `usd-per-second`: `default` é o que se paga por
 * segundo sem `resolution` e `byResolution` só existe quando dá para escolher
 * a resolução. `usd-per-video`: resolução → segundos → US$ do vídeo inteiro.
 */
export type VideoModelPriceCard =
  | {
      readonly unit: 'usd-per-second';
      readonly default: number | null;
      readonly byResolution?: Readonly<Record<string, number>>;
      /** Gemini Omni: cobra por token (US$ por milhão); a tabela por segundo é aproximada. */
      readonly billedByTokensUsdPerMillion?: GeminiOmniTokenPricing;
      /** Cada imagem de entrada (inicial, final, referência), somada ao vídeo. */
      readonly inputImageUsd?: number;
    }
  | {
      readonly unit: 'usd-per-video';
      readonly byResolution: Readonly<Record<string, Readonly<Record<string, number>>>>;
    };

/**
 * O que um agente precisa para escolher um modelo de vídeo sem chamar e
 * receber a recusa (F-1598): as regras que `videoRequestProblem` aplica, o
 * preço de lista e o desligamento, estruturados para comparar. Qualidade não
 * entra: o Nexus não mediu nenhum modelo contra outro.
 */
export interface VideoModelCard {
  /** Durações aceitas (s); `null` = o modelo decide e o pedido não leva `durationSeconds`. */
  readonly durationsSeconds: readonly number[] | null;
  readonly defaultDurationSeconds: number | null;
  /** Só onde a resolução restringe a duração (Veo 1080p/4k: 8 s). */
  readonly durationsByResolution?: Readonly<Record<string, readonly number[]>>;
  /** Durações aceitas com `imagePath` (Ray 3.2: 5 s). */
  readonly durationsWithImage?: readonly number[];
  /** `[]` = não aceita `resolution`. */
  readonly resolutions: readonly string[];
  readonly defaultResolution: string | null;
  /** `[]` = não aceita `aspectRatio` (segue a imagem inicial). */
  readonly aspectRatios: readonly string[];
  /** Sem `imagePath` o serviço recusa. */
  readonly requiresImage: boolean;
  readonly price: VideoModelPriceCard;
  /** Custo de lista do pedido só com os padrões do modelo; `null` quando o modelo decide a duração. */
  readonly defaultRequestCostUsd: number | null;
  /** Dia (AAAA-MM-DD, UTC) em que o fornecedor desliga; `null` = sem data anunciada. */
  readonly retiresOn: string | null;
  readonly retired: boolean;
  readonly replacement: string | null;
  /** A mesma linha do catálogo de Ajustes → Modelos de mídia. */
  readonly summary: string;
}

function videoPriceCard(model: string, spec: VideoModelSpec): VideoModelPriceCard {
  if (spec.pricing.kind === 'per-video') {
    return {
      unit: 'usd-per-video',
      byResolution: Object.fromEntries(
        Object.entries(spec.pricing.usd).map(([resolution, bySeconds]) => [resolution, { ...bySeconds }]),
      ),
    };
  }
  const { usd } = spec.pricing;
  const byResolution: Record<string, number> = {};
  for (const resolution of spec.resolutions) {
    const price = usd[resolution] ?? usd['*'];
    if (typeof price === 'number') byResolution[resolution] = price;
  }
  return {
    unit: 'usd-per-second',
    default: videoCostPerSecondUsd(model),
    ...(spec.resolutions.length > 0 ? { byResolution } : {}),
    ...(spec.tokenPricingUsdPerMillion
      ? { billedByTokensUsdPerMillion: { ...spec.tokenPricingUsdPerMillion } }
      : {}),
    ...(spec.inputImageUsd !== undefined ? { inputImageUsd: spec.inputImageUsd } : {}),
  };
}

/** Cartão do modelo para os agentes; `null` para modelo fora da tabela. */
export function videoModelCard(model: string, now: number = Date.now()): VideoModelCard | null {
  const spec = videoModelSpec(model);
  if (!spec) return null;
  const picksDuration = modelPicksVideoDuration(spec);
  return {
    durationsSeconds: picksDuration ? null : [...spec.durations],
    defaultDurationSeconds: spec.defaultDuration ?? null,
    ...(spec.durationsByResolution
      ? {
          durationsByResolution: Object.fromEntries(
            Object.entries(spec.durationsByResolution).map(([resolution, durations]) => [
              resolution,
              [...durations],
            ]),
          ),
        }
      : {}),
    ...(spec.durationsWithImage ? { durationsWithImage: [...spec.durationsWithImage] } : {}),
    resolutions: [...spec.resolutions],
    defaultResolution: spec.resolutions.length > 0 ? (spec.defaultResolution ?? null) : null,
    aspectRatios: [...spec.aspectRatios],
    requiresImage: spec.requiresImage === true,
    price: videoPriceCard(model, spec),
    defaultRequestCostUsd: estimateVideoCostUsd(model, {}),
    retiresOn: spec.retiresOn ?? null,
    retired: isVideoModelRetired(spec, now),
    replacement: spec.replacement ?? null,
    summary: videoModelSummary(model, now) ?? '',
  };
}
