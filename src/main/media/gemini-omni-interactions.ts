import type { GeminiOmniUsage } from '../../shared/media-video-models';

/**
 * Contrato do Gemini Omni na Interactions API (F-1587), puro: o corpo do
 * `POST /v1beta/interactions`, a leitura da resposta e do `usage`, e a frase
 * do estouro de tempo do `fetch`. A rede, a Files API e o arquivo ficam no
 * motor (`media-generation.ts`).
 *
 * Fontes, conferidas em 19/10/2026: ai.google.dev/gemini-api/docs/omni e a
 * referência ai.google.dev/api/interactions-api, mais o que a geração real
 * devolveu (formato do `usage`, `store` obrigatório com entrega por URI).
 */

export const GEMINI_HOST = 'generativelanguage.googleapis.com';
const GEMINI_FILE_ID = /(?:^|\/)files\/([A-Za-z0-9_-]{1,128})(?::download)?(?:[?#]|$)/u;

export function isGeminiOmniModel(model: string): boolean {
  return model.startsWith('gemini-omni-');
}

/** O job salvo aponta para um arquivo da Files API (`files/<id>`). */
export function isGeminiFileTarget(pollTarget: string): boolean {
  return GEMINI_FILE_ID.test(pollTarget);
}

export interface OmniInlineImage {
  readonly mimeType: string;
  /** Base64. */
  readonly data: string;
}

export interface OmniImages {
  readonly start?: OmniInlineImage;
  readonly end?: OmniInlineImage;
  readonly references?: readonly OmniInlineImage[];
}

function imagePart(image: OmniInlineImage): Record<string, string> {
  return { type: 'image', data: image.data, mime_type: image.mimeType };
}

/**
 * Corpo do `POST /v1beta/interactions`. Imagens vão antes do texto, e o
 * papel de cada uma é dito no início do prompt pela sintaxe declarativa da
 * documentação (`[# Sources <FIRST_FRAME>@Image1]`, `[# References
 * <IMAGE_REF_0>@Image2]`), em vez de deixar o modelo adivinhar.
 */
export function geminiOmniRequest(
  req: { prompt: string; aspectRatio?: string; resolution?: string },
  model: string,
  images: OmniImages = {},
): Record<string, unknown> {
  const { start, end } = images;
  const references = images.references ?? [];
  if (end && !start) {
    throw new Error(
      `${model} usa a imagem final junto da inicial: informe também a imagem inicial (imagePath).`,
    );
  }
  const responseFormat: Record<string, string> = { type: 'video', delivery: 'uri' };
  if (req.aspectRatio) responseFormat.aspect_ratio = req.aspectRatio;
  if (req.resolution) responseFormat.resolution = req.resolution;

  const ordered = [start, end, ...references].filter(
    (image): image is OmniInlineImage => image !== undefined,
  );
  let input: string | Array<Record<string, string>> = req.prompt;
  let task: string | undefined = 'text_to_video';
  if (ordered.length > 0) {
    const sources: string[] = [];
    if (start) sources.push('<FIRST_FRAME>@Image1');
    if (end) sources.push('<LAST_FRAME>@Image2');
    const firstReference = sources.length + 1;
    const refs = references.map((_ref, index) => `<IMAGE_REF_${index}>@Image${firstReference + index}`);
    const roles = [
      sources.length > 0 ? `[# Sources ${sources.join(' ')}]` : '',
      refs.length > 0 ? `[# References ${refs.join(' ')}]` : '',
    ].filter(Boolean);
    input = [...ordered.map(imagePart), { type: 'text', text: `${roles.join(' ')}\n${req.prompt}` }];
    // Moldura e referência juntas: o modelo infere a tarefa pelos papéis.
    task = refs.length === 0 ? 'image_to_video' : sources.length === 0 ? 'reference_to_video' : undefined;
  }
  return {
    model,
    input,
    response_format: responseFormat,
    ...(task ? { generation_config: { video_config: { task } } } : {}),
    // A entrega por URI exige guardar a interação no projeto da chave
    // (HTTP 400 ao vivo em 19/10/2026: "store=true is required when response
    // format has video delivery set to URI"). É a entrega que a documentação
    // recomenda acima de 4 MB e a que deixa retomar pela Files API.
    store: true,
  };
}

export interface GeminiOmniOutput {
  /** Vídeo em base64 (entrega inline). */
  data?: string;
  /** Id da Files API (`files/<id>`), da entrega por URI. */
  fileId?: string;
  /** URI que não é da Files API: baixada sem a chave, pela lista de hosts. */
  uri?: string;
  interactionId?: string;
  status?: string;
  /** Texto do modelo (recusa, explicação) para a frase de erro. */
  text: string;
  /** Tokens cobrados, quando a resposta traz `usage`. */
  usage?: GeminiOmniUsage;
}

function tokenCount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/**
 * `usage` como veio ao vivo em 19/10/2026: `total_input_tokens`,
 * `total_output_tokens`, `output_tokens_by_modality: [{ modality: "video",
 * tokens }]` e `total_thought_tokens` (fora do total de saída).
 */
function usageFrom(raw: unknown): GeminiOmniUsage | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const usage = raw as Record<string, unknown>;
  const byModality = Array.isArray(usage.output_tokens_by_modality)
    ? (usage.output_tokens_by_modality as Array<Record<string, unknown>>)
    : [];
  const videoTokens = byModality
    .filter((entry) => String(entry?.modality).toLowerCase() === 'video')
    .reduce((sum, entry) => sum + (tokenCount(entry.tokens) ?? 0), 0);
  const totalOutput = tokenCount(usage.total_output_tokens);
  if (videoTokens === 0 || totalOutput === undefined) return undefined;
  return {
    inputTokens: tokenCount(usage.total_input_tokens) ?? 0,
    videoTokens,
    textTokens: Math.max(0, totalOutput - videoTokens) + (tokenCount(usage.total_thought_tokens) ?? 0),
  };
}

function videoFrom(item: unknown): { data?: string; uri?: string } | null {
  if (!item || typeof item !== 'object') return null;
  const record = item as Record<string, unknown>;
  const data = typeof record.data === 'string' && record.data ? record.data : undefined;
  const uri = typeof record.uri === 'string' && record.uri ? record.uri : undefined;
  return data || uri ? { data, uri } : null;
}

/**
 * Lê a interação: o último item `video` dos passos `model_output` (a forma
 * documentada e a que veio ao vivo), de `outputs[]` (a forma mais antiga da
 * Interactions API) ou de `output_video` (o atalho que o exemplo em shell da
 * documentação lê).
 */
export function extractGeminiOmniOutput(body: Record<string, unknown>): GeminiOmniOutput {
  const items: unknown[] = [];
  if (Array.isArray(body.steps)) {
    for (const step of body.steps as Array<Record<string, unknown>>) {
      if (step?.type === 'model_output' && Array.isArray(step.content)) items.push(...step.content);
    }
  }
  if (Array.isArray(body.outputs)) items.push(...body.outputs);
  let video: { data?: string; uri?: string } | null = null;
  const texts: string[] = [];
  for (const item of items) {
    const record = item as Record<string, unknown> | null;
    if (record?.type === 'video') video = videoFrom(record) ?? video;
    if (record?.type === 'text' && typeof record.text === 'string') texts.push(record.text);
  }
  video ??= videoFrom(body.output_video);
  const fileId = video?.uri ? GEMINI_FILE_ID.exec(video.uri)?.[1] : undefined;
  const usage = usageFrom(body.usage);
  return {
    ...(video?.data ? { data: video.data } : {}),
    ...(fileId ? { fileId: `files/${fileId}` } : video?.uri ? { uri: video.uri } : {}),
    ...(typeof body.id === 'string' ? { interactionId: body.id } : {}),
    ...(typeof body.status === 'string' ? { status: body.status } : {}),
    text: texts.join(' ').replace(/\s+/gu, ' ').trim().slice(0, 300),
    ...(usage ? { usage } : {}),
  };
}

/** O `fetch` do Node desiste depois de 5 min sem cabeçalho de resposta. */
export function geminiOmniTransportError(err: unknown): unknown {
  const code = (err as { cause?: { code?: unknown } } | null)?.cause?.code;
  if (code === 'UND_ERR_HEADERS_TIMEOUT') {
    return new Error(
      'O Google não terminou o vídeo em 5 minutos e a conexão caiu; o vídeo não chegou. ' +
        'Tente de novo em 720p ou 360p, que saem mais rápido.',
    );
  }
  return err;
}
