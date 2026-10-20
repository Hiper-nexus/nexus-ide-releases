/**
 * Catálogo da Higgsfield (F-1613), lido pelo Main (endpoint e corpo de cada
 * pedido) e pelo Estúdio (quantas referências cada modelo recebe). Só dados.
 *
 * Fonte: `docs.higgsfield.ai/docs/models/<família>/<fluxo>.md`, seção
 * "Complete JSON schema" de cada página, lidas em 20/10/2026. O id do Nexus
 * (`higgsfield/…`) é a família; o motor escolhe o fluxo (texto, imagem ou
 * referência) pelo que o pedido leva. Preço: a Higgsfield cobra em crédito e
 * informa o valor em USD por pedido (`POST /estimate/{endpoint}`) — o Nexus
 * não guarda tabela, pergunta antes de gerar.
 */

export interface HiggsfieldVideoModel {
  readonly label: string;
  readonly textToVideo: string;
  readonly imageToVideo?: string;
  readonly referenceToVideo?: string;
  /** Campo do último quadro no imagem→vídeo. */
  readonly endImageField?: 'end_image_url' | 'last_image_url';
  /** O imagem→vídeo também aceita `aspect_ratio`. */
  readonly aspectInImageToVideo?: boolean;
  /** Teto de `image_urls` / `video_urls` no referência→vídeo. */
  readonly maxReferenceImages: number;
  readonly maxReferenceVideos: number;
  /** Campos fixos do pedido (áudio ligado, sem marca d'água). */
  readonly fixed?: Readonly<Record<string, unknown>>;
}

export const HIGGSFIELD_VIDEO_MODELS: Readonly<Record<string, HiggsfieldVideoModel>> = Object.freeze({
  'higgsfield/seedance-2.5': {
    label: 'Seedance 2.5',
    textToVideo: 'bytedance/seedance-2.5/text-to-video',
    imageToVideo: 'bytedance/seedance-2.5/image-to-video',
    referenceToVideo: 'bytedance/seedance-2.5/reference-to-video',
    endImageField: 'end_image_url',
    maxReferenceImages: 30,
    maxReferenceVideos: 10,
    fixed: { generate_audio: true },
  },
  'higgsfield/seedance-2.0': {
    label: 'Seedance 2.0',
    textToVideo: 'bytedance/seedance-2.0/text-to-video',
    imageToVideo: 'bytedance/seedance-2.0/image-to-video',
    referenceToVideo: 'bytedance/seedance-2.0/reference-to-video',
    endImageField: 'end_image_url',
    maxReferenceImages: 9,
    maxReferenceVideos: 3,
    fixed: { generate_audio: true },
  },
  'higgsfield/kling-3.0-pro': {
    label: 'Kling 3.0 Pro',
    textToVideo: 'kling-video/v3.0/pro/text-to-video',
    imageToVideo: 'kling-video/v3.0/pro/image-to-video',
    endImageField: 'last_image_url',
    maxReferenceImages: 0,
    maxReferenceVideos: 0,
    fixed: { sound: 'on' },
  },
  'higgsfield/minimax-h3': {
    label: 'MiniMax H3 (Hailuo 3)',
    textToVideo: 'minimax/h3/text-to-video',
    imageToVideo: 'minimax/h3/image-to-video',
    referenceToVideo: 'minimax/h3/reference-to-video',
    endImageField: 'end_image_url',
    aspectInImageToVideo: true,
    maxReferenceImages: 9,
    maxReferenceVideos: 3,
    fixed: { aigc_watermark: false },
  },
  'higgsfield/wan-3.0': {
    label: 'Wan 3.0',
    textToVideo: 'alibaba/wan-3.0/text-to-video',
    imageToVideo: 'alibaba/wan-3.0/image-to-video',
    referenceToVideo: 'alibaba/wan-3.0/reference-to-video',
    endImageField: 'end_image_url',
    aspectInImageToVideo: true,
    maxReferenceImages: 10,
    maxReferenceVideos: 5,
    fixed: { generate_audio: true },
  },
});

export interface HiggsfieldImageModel {
  readonly label: string;
  readonly textToImage: string;
  /** Edição com imagens de entrada; ausente = o modelo só gera do texto. */
  readonly edit?: string;
  readonly editField?: 'image_url' | 'image_urls';
  /** Quantas imagens de entrada (0 = nenhuma). */
  readonly maxInputImages: number;
  readonly aspectRatios: readonly string[];
  readonly fixed?: Readonly<Record<string, unknown>>;
}

export const HIGGSFIELD_IMAGE_MODELS: Readonly<Record<string, HiggsfieldImageModel>> = Object.freeze({
  'higgsfield/soul-2': {
    label: 'Higgsfield Soul 2',
    textToImage: 'higgsfield-ai/soul/v2/standard',
    maxInputImages: 0,
    aspectRatios: ['9:16', '16:9', '4:3', '3:4', '1:1', '2:3', '3:2'],
    fixed: { resolution: '1080p', batch_size: 1 },
  },
  'higgsfield/ideogram-4': {
    label: 'Ideogram 4 (texto e logo)',
    textToImage: 'ideogram/v4.0',
    edit: 'ideogram/v4.0',
    editField: 'image_url',
    maxInputImages: 1,
    aspectRatios: ['1:1', '16:9', '9:16', '4:3', '3:4', '2:3', '3:2', '4:5', '5:4'],
  },
  'higgsfield/qwen-image-3': {
    label: 'Qwen Image 3',
    textToImage: 'alibaba/qwen-image-3/text-to-image',
    edit: 'alibaba/qwen-image-3/edit',
    editField: 'image_urls',
    maxInputImages: 3,
    aspectRatios: ['1:1', '2:3', '3:2', '3:4', '4:3', '9:16', '16:9', '21:9'],
  },
  'higgsfield/recraft-4.1': {
    label: 'Recraft 4.1',
    textToImage: 'recraft/v4.1/text-to-image',
    maxInputImages: 0,
    aspectRatios: ['1:1', '3:2', '2:3', '4:3', '3:4', '16:9', '9:16'],
    fixed: { output_format: 'png' },
  },
});

export function higgsfieldVideoModel(model: string): HiggsfieldVideoModel | null {
  return HIGGSFIELD_VIDEO_MODELS[model] ?? null;
}

export function higgsfieldImageModel(model: string): HiggsfieldImageModel | null {
  return HIGGSFIELD_IMAGE_MODELS[model] ?? null;
}
