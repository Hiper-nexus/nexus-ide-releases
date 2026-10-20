import type { OmniInlineImage } from './gemini-omni-interactions';

/**
 * Imagem do Gemini pela Interactions API (`POST /v1beta/interactions`), puro:
 * o corpo do pedido e a leitura da resposta. A rede e o arquivo ficam no motor
 * (`media-generation.ts`).
 *
 * Fonte (ai.google.dev/gemini-api/docs/image-generation, lida em 20/10/2026):
 * os modelos estáveis da família Nano Banana (`gemini-nano-banana-2.1`,
 * `gemini-3.1-flash-image`, `gemini-3.1-flash-lite-image`, `gemini-3-pro-image`)
 * são documentados só nela, com `response_format: { type: 'image', … }` e a
 * imagem em base64. O `generateContent` continua nos ids antigos.
 */

/** Ids que seguem pelo `generateContent` (os que já funcionavam antes). */
const GENERATE_CONTENT_IMAGE_MODELS: ReadonlySet<string> = new Set([
  'gemini-3.1-flash-image-preview',
  'gemini-2.5-flash-image',
]);

export function geminiImageUsesInteractions(model: string): boolean {
  return !GENERATE_CONTENT_IMAGE_MODELS.has(model);
}

/** Tamanho pedido: 1K é o preço de lista que o Estúdio mostra (o Lite só faz 1K). */
const IMAGE_SIZE = '1K';

export function geminiImageRequest(
  req: { prompt: string; aspectRatio?: string },
  model: string,
  image?: OmniInlineImage,
): Record<string, unknown> {
  const responseFormat: Record<string, string> = {
    type: 'image',
    mime_type: 'image/png',
    image_size: IMAGE_SIZE,
  };
  if (req.aspectRatio) responseFormat.aspect_ratio = req.aspectRatio;
  return {
    model,
    input: image
      ? [
          { type: 'image', data: image.data, mime_type: image.mimeType },
          { type: 'text', text: req.prompt },
        ]
      : req.prompt,
    response_format: responseFormat,
  };
}

export interface GeminiImageOutput {
  /** Imagem em base64. */
  data?: string;
  /** Texto do modelo (recusa, explicação) para a frase de erro. */
  text: string;
}

function imageData(item: unknown): string | undefined {
  if (!item || typeof item !== 'object') return undefined;
  const data = (item as Record<string, unknown>).data;
  return typeof data === 'string' && data ? data : undefined;
}

/**
 * Lê a interação: o último item `image` dos passos `model_output` (a forma
 * documentada), de `outputs[]` (a forma mais antiga) ou de `output_image` (o
 * atalho que o exemplo da documentação lê).
 */
export function extractGeminiImage(body: Record<string, unknown>): GeminiImageOutput {
  const items: unknown[] = [];
  if (Array.isArray(body.steps)) {
    for (const step of body.steps as Array<Record<string, unknown>>) {
      if (step?.type === 'model_output' && Array.isArray(step.content)) items.push(...step.content);
    }
  }
  if (Array.isArray(body.outputs)) items.push(...body.outputs);
  let data: string | undefined;
  const texts: string[] = [];
  for (const item of items) {
    const record = item as Record<string, unknown> | null;
    if (record?.type === 'image') data = imageData(record) ?? data;
    if (record?.type === 'text' && typeof record.text === 'string') texts.push(record.text);
  }
  data ??= imageData(body.output_image);
  return {
    ...(data ? { data } : {}),
    text: texts.join(' ').replace(/\s+/gu, ' ').trim().slice(0, 300),
  };
}
