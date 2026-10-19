/**
 * Contrato do Grok Imagine na API da xAI (F-1599), puro: o corpo dos pedidos
 * de imagem e de vídeo, o que cada modelo aceita além da tabela de vídeo, a
 * leitura da resposta e do polling, e o custo que a xAI informa. A rede, o
 * polling e o arquivo ficam no motor (`media-generation.ts`).
 *
 * Fontes, conferidas em 19/10/2026 (docs.x.ai, `dateModified` de cada página):
 * - `developers/rest-api-reference/inference/videos` (13/04): `POST
 *   /v1/videos/generations` → `{ request_id }`; `GET /v1/videos/{request_id}`
 *   → `status`, `video.url`, `video.duration`, `video.respect_moderation`,
 *   `error.code`, `usage.cost_in_usd_ticks` (1 USD = 10^10 ticks).
 * - `developers/model-capabilities/video/generation` (10/10) e `video/overview`
 *   (08/10): duração 1–15 s, resoluções por modelo, proporções, imagem inicial
 *   (a saída segue a proporção dela), `last_frame` e referências por modelo.
 * - `developers/rest-api-reference/inference/images` (02/10) e
 *   `images/generation` (08/10): `POST /v1/images/generations` e `/edits`,
 *   `response_format: "b64_json"`, `resolution` 1k/1.5k/2k, `aspect_ratio`.
 * - `developers/pricing` (10/10): preço por imagem e por segundo de vídeo, por
 *   resolução (a tabela do HTML; o `.md` só traz o piso).
 * - `developers/debugging` (13/05): chave incorreta é HTTP 400 (visto ao vivo
 *   com chave falsa: `{"code":"invalid-argument","error":"Incorrect API key
 *   provided…"}`).
 */

export const XAI_API_BASE = 'https://api.x.ai/v1';

export interface XaiInlineImage {
  readonly mimeType: string;
  /** Base64. */
  readonly data: string;
}

function dataUrl(image: XaiInlineImage): string {
  return `data:${image.mimeType};base64,${image.data}`;
}

/** `usage.cost_in_usd_ticks` em USD (1 USD = 10^10 ticks); ausente se não veio. */
export function xaiCostUsd(usage: unknown): number | undefined {
  if (!usage || typeof usage !== 'object') return undefined;
  const ticks = (usage as Record<string, unknown>).cost_in_usd_ticks;
  if (typeof ticks !== 'number' || !Number.isFinite(ticks) || ticks < 0) return undefined;
  return Number((ticks / 1e10).toFixed(4));
}

function clip(text: string, max = 300): string {
  const flat = text.replace(/\s+/gu, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

// ── Imagem ───────────────────────────────────────────────────────────────────

/**
 * Preço de lista por imagem gerada, por resolução, na qualidade que a xAI usa
 * quando o pedido não diz (`auto` = `low` na geração). Fonte: as páginas de
 * cada modelo em docs.x.ai/developers/models (lidas renderizadas em
 * 19/10/2026). O custo real vem do `usage`; a tabela é a reserva.
 */
export const XAI_IMAGE_USD: Readonly<Record<string, Readonly<Record<string, number>>>> = {
  'grok-imagine-image-2.0': { '1k': 0.04, '1.5k': 0.05, '2k': 0.06 },
  'grok-imagine-image-quality': { '1k': 0.05, '1.5k': 0.06, '2k': 0.07 },
  'grok-imagine-image': { '1k': 0.02, '2k': 0.02 },
};

export const XAI_IMAGE_ASPECTS: readonly string[] = [
  '1:1', '3:4', '4:3', '9:16', '16:9', '2:3', '3:2', '9:19.5', '19.5:9',
  '9:20', '20:9', '1:2', '2:1', '21:9', '5:2', 'auto',
];

/** `1K` (o `size` do Nexus) → `1k`; `undefined` deixa a xAI no padrão (1k). */
export function xaiImageResolution(model: string, size?: string): string | undefined {
  const wanted = size?.trim().toLowerCase();
  if (!wanted) return undefined;
  const accepted = Object.keys(XAI_IMAGE_USD[model] ?? {});
  if (!accepted.includes(wanted)) {
    throw new Error(
      `${model} aceita tamanho ${accepted.map((r) => r.toUpperCase()).join(', ')} (pedido: ${size}).`,
    );
  }
  return wanted;
}

/**
 * Edição: com `auto` o 2.0 sai em `medium` («`auto` currently serves `low` on
 * generation and `medium` on edit», guia de prompts da xAI); os outros dois
 * têm um preço só por resolução. Revisão do PR #145.
 */
const XAI_IMAGE_EDIT_USD: Readonly<Record<string, Readonly<Record<string, number>>>> = {
  'grok-imagine-image-2.0': { '1k': 0.06, '1.5k': 0.07, '2k': 0.08 },
};

/** Imagem de entrada da edição, cobrada à parte («Image input»). */
const XAI_IMAGE_INPUT_USD: Readonly<Record<string, number>> = {
  'grok-imagine-image-2.0': 0.01,
  'grok-imagine-image-quality': 0.01,
  'grok-imagine-image': 0.002,
};

export function xaiImageCostUsd(
  model: string,
  resolution?: string,
  options: { inputImages?: number } = {},
): number | null {
  const inputs = options.inputImages ?? 0;
  const table = inputs > 0 ? (XAI_IMAGE_EDIT_USD[model] ?? XAI_IMAGE_USD[model]) : XAI_IMAGE_USD[model];
  const output = table?.[resolution ?? '1k'];
  if (output === undefined) return null;
  const input = XAI_IMAGE_INPUT_USD[model];
  if (inputs > 0 && input === undefined) return null;
  return Number((output + inputs * (input ?? 0)).toFixed(4));
}

/**
 * Pedido de imagem: com imagem do projeto é edição (`/images/edits`), sem é
 * geração. A resposta vem em base64 (nada para baixar de outro host).
 */
export function xaiImageRequest(
  req: { prompt: string; aspectRatio?: string; size?: string },
  model: string,
  image?: XaiInlineImage,
): { endpoint: 'images/generations' | 'images/edits'; body: Record<string, unknown> } {
  if (req.aspectRatio !== undefined && !XAI_IMAGE_ASPECTS.includes(req.aspectRatio)) {
    throw new Error(`${model} aceita proporção ${XAI_IMAGE_ASPECTS.join(', ')} (pedido: ${req.aspectRatio}).`);
  }
  const resolution = xaiImageResolution(model, req.size);
  const body: Record<string, unknown> = {
    model,
    prompt: req.prompt,
    response_format: 'b64_json',
    ...(req.aspectRatio ? { aspect_ratio: req.aspectRatio } : {}),
    ...(resolution ? { resolution } : {}),
    ...(image ? { image: { url: dataUrl(image) } } : {}),
  };
  return { endpoint: image ? 'images/edits' : 'images/generations', body };
}

export interface XaiImageOutput {
  readonly data: Buffer;
  /** `jpg`, `png` ou `webp`, pelo `mime_type` da resposta (padrão JPEG). */
  readonly extension: string;
  readonly costUsd?: number;
}

const IMAGE_EXTENSIONS: Readonly<Record<string, string>> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

export function extractXaiImage(body: Record<string, unknown>): XaiImageOutput {
  const first = Array.isArray(body.data) ? (body.data[0] as Record<string, unknown> | undefined) : undefined;
  const b64 = typeof first?.b64_json === 'string' ? first.b64_json : '';
  if (!b64) {
    throw new Error('A xAI respondeu sem a imagem em base64; nada foi salvo.');
  }
  const mime = typeof first?.mime_type === 'string' ? first.mime_type.toLowerCase() : 'image/jpeg';
  const costUsd = xaiCostUsd(body.usage);
  return {
    data: Buffer.from(b64, 'base64'),
    extension: IMAGE_EXTENSIONS[mime] ?? 'jpg',
    ...(costUsd !== undefined ? { costUsd } : {}),
  };
}

const IMAGE_FILE_EXTENSION = /\.(png|jpe?g|webp)$/iu;

/**
 * O arquivo leva a extensão do formato que a xAI devolveu, inclusive quando
 * quem chamou deu o `outPath` (revisão do PR #145): a galeria e quem abre o
 * arquivo leem o tipo pela extensão, então JPEG gravado em `.png` não abre
 * direito. Mesmo formato mantém o nome pedido (`.jpeg` para JPEG); sem
 * extensão de imagem, a certa é acrescentada. Fica na mesma pasta.
 */
export function xaiImageOutputPath(outPath: string, extension: string): string {
  const current = IMAGE_FILE_EXTENSION.exec(outPath)?.[1]?.toLowerCase();
  if (current === undefined) return `${outPath}.${extension}`;
  const same = current === extension || (current === 'jpeg' && extension === 'jpg');
  return same ? outPath : outPath.replace(IMAGE_FILE_EXTENSION, `.${extension}`);
}

// ── Vídeo ────────────────────────────────────────────────────────────────────

interface XaiVideoInputs {
  /** Imagens de referência (`reference_images`); 0 = o modelo não usa. */
  readonly maxReferences: number;
  /** Último quadro fixado (`last_frame`). */
  readonly lastFrame: boolean;
  /** Imagem inicial junto de referências. */
  readonly imageWithReferences: boolean;
  /** Duração máxima com referências. */
  readonly referenceMaxSeconds: number;
}

/** Tabela "Capabilities and specifications" de `video/overview` (08/10). */
const XAI_VIDEO_INPUTS: Readonly<Record<string, XaiVideoInputs>> = {
  'grok-imagine-video-1.5': { maxReferences: 14, lastFrame: true, imageWithReferences: true, referenceMaxSeconds: 15 },
  'grok-imagine-video-1.5-lite': { maxReferences: 0, lastFrame: false, imageWithReferences: false, referenceMaxSeconds: 0 },
  'grok-imagine-video': { maxReferences: 7, lastFrame: false, imageWithReferences: false, referenceMaxSeconds: 10 },
};

export function isXaiVideoModel(model: string): boolean {
  return model in XAI_VIDEO_INPUTS;
}

/**
 * O que a tabela geral de vídeo não cobre: imagem final e referências por
 * modelo. Referência-para-vídeo (referências ou último quadro) vai até 720p.
 * Frase em pt-BR, ou `null`; roda antes de qualquer chamada paga.
 */
export function xaiVideoInputProblem(
  model: string,
  input: {
    hasImage: boolean;
    hasEndImage: boolean;
    referenceCount: number;
    resolution?: string;
    durationSeconds?: number;
  },
): string | null {
  const caps = XAI_VIDEO_INPUTS[model];
  if (!caps) return null;
  if (input.hasEndImage && !caps.lastFrame) {
    return `${model} não fixa o último quadro: use grok-imagine-video-1.5 ou tire a imagem final (endImagePath).`;
  }
  if (input.referenceCount > caps.maxReferences) {
    return caps.maxReferences === 0
      ? `${model} não usa imagens de referência: use grok-imagine-video-1.5 ou tire referenceImagePaths.`
      : `${model} aceita até ${caps.maxReferences} imagens de referência (pedido: ${input.referenceCount}).`;
  }
  const references = input.referenceCount > 0;
  if (references && input.hasImage && !caps.imageWithReferences) {
    return `${model} não junta imagem inicial com referências: use grok-imagine-video-1.5 ou escolha uma das duas.`;
  }
  if ((references || input.hasEndImage) && input.resolution === '1080p') {
    return `${model} com referências ou último quadro vai até 720p (pedido: 1080p).`;
  }
  if (references && input.durationSeconds !== undefined && input.durationSeconds > caps.referenceMaxSeconds) {
    return `${model} com referências vai até ${caps.referenceMaxSeconds} segundos (pedido: ${input.durationSeconds} s).`;
  }
  return null;
}

export interface XaiVideoImages {
  readonly start?: XaiInlineImage;
  readonly end?: XaiInlineImage;
  readonly references?: readonly XaiInlineImage[];
}

/**
 * Corpo do `POST /v1/videos/generations`. Com imagem inicial a saída segue a
 * proporção dela e a xAI ignora `aspect_ratio`: o campo não vai.
 */
export function xaiVideoRequest(
  req: { prompt: string; durationSeconds?: number; aspectRatio?: string; resolution?: string },
  model: string,
  images: XaiVideoImages = {},
): Record<string, unknown> {
  const references = images.references ?? [];
  if (!req.prompt.trim() && !images.start && !images.end && references.length === 0) {
    throw new Error('Vídeo do Grok sem imagem precisa de um texto (prompt).');
  }
  return {
    model,
    ...(req.prompt.trim() ? { prompt: req.prompt } : {}),
    ...(req.durationSeconds !== undefined ? { duration: req.durationSeconds } : {}),
    ...(req.aspectRatio && !images.start ? { aspect_ratio: req.aspectRatio } : {}),
    ...(req.resolution ? { resolution: req.resolution } : {}),
    ...(images.start ? { image: { url: dataUrl(images.start) } } : {}),
    ...(images.end ? { last_frame: { url: dataUrl(images.end) } } : {}),
    ...(references.length > 0
      ? { reference_images: references.map((image) => ({ url: dataUrl(image) })) }
      : {}),
  };
}

const REQUEST_ID = /^[A-Za-z0-9-]{1,128}$/u;

/**
 * O `request_id` da resposta, conferido antes de virar caminho de URL (o job
 * salvo no projeto também passa por aqui na retomada).
 */
export function xaiRequestId(raw: unknown): string {
  const id = raw && typeof raw === 'object' ? (raw as Record<string, unknown>).request_id : raw;
  if (typeof id !== 'string' || !REQUEST_ID.test(id)) {
    throw new Error('A xAI não devolveu um request_id válido; nada foi gerado.');
  }
  return id;
}

export function xaiVideoPollUrl(requestId: string): string {
  return `${XAI_API_BASE}/videos/${encodeURIComponent(xaiRequestId(requestId))}`;
}

export type XaiVideoPoll =
  | { readonly state: 'pending'; readonly progress?: number }
  | {
      readonly state: 'done';
      readonly url: string;
      readonly durationSeconds?: number;
      readonly costUsd?: number;
    }
  | { readonly state: 'failed'; readonly problem: string };

/** O que fazer com cada `error.code` do vídeo (tabela de `video/generation`). */
const VIDEO_ERROR_PT: Readonly<Record<string, string>> = {
  invalid_argument:
    'A xAI recusou o pedido: parâmetro inválido ou conteúdo barrado pela moderação. Mude o pedido e gere de novo.',
  permission_denied:
    'A chave ou a equipe da xAI não tem permissão para gerar vídeo. Confira a equipe da chave no console da xAI.',
  failed_precondition:
    'O modelo não faz isso com essas opções (resolução ou modo). Troque o modelo ou as opções.',
  service_unavailable: 'A geração de vídeo da xAI está sobrecarregada. Tente de novo mais tarde.',
  internal_error: 'A xAI falhou ao gerar o vídeo. Tente de novo.',
};

/**
 * Lê o `GET /v1/videos/{request_id}`: `done` só com URL e moderação
 * respeitada; `failed`/`expired` com a frase do que fazer; o resto é espera.
 */
export function readXaiVideoPoll(body: Record<string, unknown>): XaiVideoPoll {
  const status = typeof body.status === 'string' ? body.status : '';
  if (status === 'done') {
    const video = (body.video && typeof body.video === 'object' ? body.video : {}) as Record<string, unknown>;
    if (video.respect_moderation === false) {
      return {
        state: 'failed',
        problem:
          'A xAI barrou o vídeo na moderação e não entregou o arquivo; nada foi salvo (a xAI cobra a geração mesmo assim).',
      };
    }
    const url = typeof video.url === 'string' && video.url ? video.url : '';
    if (!url) return { state: 'failed', problem: 'A xAI concluiu sem a URL do vídeo; nada foi salvo.' };
    const seconds = typeof video.duration === 'number' && video.duration > 0 ? video.duration : undefined;
    const costUsd = xaiCostUsd(body.usage);
    return {
      state: 'done',
      url,
      ...(seconds !== undefined ? { durationSeconds: seconds } : {}),
      ...(costUsd !== undefined ? { costUsd } : {}),
    };
  }
  if (status === 'failed' || status === 'expired') {
    const error = (body.error && typeof body.error === 'object' ? body.error : {}) as Record<string, unknown>;
    const code = typeof error.code === 'string' ? error.code : '';
    const message = typeof error.message === 'string' ? clip(error.message) : '';
    const what =
      status === 'expired'
        ? 'O pedido de vídeo expirou na xAI antes de ficar pronto. Gere de novo.'
        : (VIDEO_ERROR_PT[code] ?? 'A xAI não concluiu o vídeo.');
    return { state: 'failed', problem: message ? `${what} Resposta do serviço: ${message}` : what };
  }
  const progress = typeof body.progress === 'number' ? body.progress : undefined;
  return progress !== undefined ? { state: 'pending', progress } : { state: 'pending' };
}
