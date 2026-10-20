import path from 'node:path';
import type { MediaGenerationResult } from '../../shared/media-types';
import {
  findMediaProvider,
  resolveMediaModel,
  resolveMediaProvider,
  resolveOutPath,
  type MediaProviderDef,
} from './media-providers';
import {
  downloadAuthenticatedProviderAsset,
  downloadProviderAsset,
  fetchPinnedProviderAsset,
} from './media-download';
import { mp4DurationSeconds } from './mp4-duration';
import {
  extractGeminiImage,
  geminiImageRequest,
  geminiImageUsesInteractions,
} from './gemini-image-interactions';
import {
  extractGeminiOmniOutput,
  geminiOmniRequest,
  geminiOmniTransportError,
  GEMINI_HOST,
  isGeminiFileTarget,
  isGeminiOmniModel,
  isGeminiOmniUsage,
} from './gemini-omni-interactions';
import {
  extractXaiImage,
  readXaiVideoPoll,
  XAI_API_BASE,
  xaiImageOutputPath,
  xaiImageRequest,
  xaiImageResolution,
  xaiRequestId,
  xaiVideoInputProblem,
  xaiVideoPollUrl,
  xaiVideoRequest,
  type XaiImageOutput,
  type XaiVideoPoll,
} from './xai-imagine';
import {
  readMediaInput,
  writeMediaOutput,
  type MediaInputFile,
} from './media-path-policy';
import { resolveBrowserHostname } from '../browser/url-policy';
import { geminiImageAspect, openaiImageSize } from './media-aspect';
import { mediaHttpError, mediaServiceName } from './media-errors';
import {
  geminiOmniCostUsd,
  modelPicksVideoDuration,
  videoModelSpec,
  videoRequestProblem,
  type GeminiOmniUsage,
} from '../../shared/media-video-models';
import {
  getVideoJob,
  jobBilling,
  MediaJobGoneError,
  savedJobBilling,
  saveVideoJob,
  settleVideoJob,
  videoInputImageCount,
  type MediaVideoJobRecord,
} from './media-video-jobs';
import {
  assertMediaAuthorityCurrent,
  dataUri,
  fileToInlineData,
  MediaJobTimeoutError,
  mediaResult as result,
  requireKey,
  sleepWhileAuthorized,
  type MediaAuthorityRequest,
  type MediaDeps,
} from './media-runtime';

import {
  replicateInput,
  replicateReferenceLimit,
} from './replicate-video-input';
import { generateImageHiggsfield, generateVideoHiggsfield } from './higgsfield';

export {
  replicateEndImageField,
  replicateImageField,
  replicateInput,
} from './replicate-video-input';

export {
  MediaAbortError,
  MediaJobInterruptedError,
  MediaJobTimeoutError,
  throwIfMediaAborted,
  type MediaDeps,
} from './media-runtime';

/**
 * Media generation engine — image (Gemini/OpenAI/Seedream/Grok Imagine), video
 * (Replicate, native Google: Gemini Omni and Veo, and xAI Grok Imagine) and
 * audio (ElevenLabs). Runs entirely in main:
 * the API key never crosses the MCP boundary; the agent receives only the
 * generated file path.
 *
 * All network/clock/key access is injected via MediaDeps so the engine is
 * unit-testable without electron or real HTTP.
 */

const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta';
const OPENAI_BASE = 'https://api.openai.com/v1';
const REPLICATE_BASE = 'https://api.replicate.com/v1';
const ELEVENLABS_BASE = 'https://api.elevenlabs.io/v1';

const REPLICATE_POLL_MS = 4_000;
const REPLICATE_MAX_POLLS = 90; // 6 min
const GOOGLE_VIDEO_POLL_MS = 5_000;
const GOOGLE_VIDEO_MAX_POLLS = 72; // 6 min
// Grok Imagine: "typically takes up to several minutes"; o SDK da xAI espera
// até 10 min com o mesmo intervalo de 5 s do exemplo REST (F-1599).
const XAI_VIDEO_POLL_MS = 5_000;
const XAI_VIDEO_MAX_POLLS = 120;
const DEFAULT_ELEVENLABS_VOICE = '21m00Tcm4TlvDq8ikWAM'; // Rachel
/** Seedance/Veo video refs (Replicate schemas typically cap near 9). */
const MAX_REFERENCE_IMAGES = 9;
/**
 * Seedream 5.0 Pro image_input: 1–10 reference images
 * (replicate.com/bytedance/seedream-5-pro OpenAPI).
 */
const MAX_SEEDREAM_REFERENCE_IMAGES = 10;
const SEEDREAM5_SIZES = new Set(['1K', '2K']);
const SEEDREAM5_ASPECTS = new Set([
  'match_input_image',
  '1:1',
  '4:3',
  '3:4',
  '16:9',
  '9:16',
  '3:2',
  '2:3',
  '21:9',
]);

export interface ImageRequest extends MediaAuthorityRequest {
  prompt: string;
  provider?: string;
  model?: string;
  /** Absolute, or relative to baseDir (must not escape it). */
  outPath?: string;
  baseDir: string;
  /** Existing image for image-to-image edits / Seedream image_input. */
  imagePath?: string;
  /**
   * Extra reference images (Seedream image_input array). imagePath is prepended
   * when both are set.
   */
  referenceImagePaths?: string[];
  /** Logical aspect ratio (Gemini native; OpenAI mapped; Seedream enum). */
  aspectRatio?: string;
  /**
   * Seedream 5.0 Pro size: 1K (~2MP) | 2K (~4MP). Default 2K.
   * (Official/Replicate schema — not 4K on 5.0 Pro.)
   */
  size?: string;
}

export interface VideoRequest extends MediaAuthorityRequest {
  prompt: string;
  provider?: string;
  model?: string;
  outPath?: string;
  baseDir: string;
  durationSeconds?: number;
  resolution?: string;
  aspectRatio?: string;
  /** Start keyframe (image-to-video). */
  imagePath?: string;
  /** End keyframe (last frame). */
  endImagePath?: string;
  /**
   * Reference images for character/style consistency (Seedance
   * reference_images / Veo reference_images). Max 9.
   */
  referenceImagePaths?: string[];
  /** F-1613: vídeos de exemplo (Higgsfield: Seedance, H3, Wan 3.0). */
  referenceVideoPaths?: string[];
  /** Resume a timed-out prediction without resubmitting. */
  recoverJobId?: string;
}

export interface AudioRequest extends MediaAuthorityRequest {
  text: string;
  provider?: string;
  model?: string;
  voiceId?: string;
  outPath?: string;
  baseDir: string;
}

// ── Image ────────────────────────────────────────────────────────────────────

async function googleImage(
  req: ImageRequest,
  def: MediaProviderDef,
  model: string,
  key: string,
  deps: MediaDeps,
  image?: MediaInputFile,
): Promise<Buffer> {
  assertMediaAuthorityCurrent(req);
  const aspect = geminiImageAspect(req.aspectRatio);
  if (geminiImageUsesInteractions(model)) {
    const inline = image ? fileToInlineData(image) : undefined;
    const created = await deps.fetchFn(`${GEMINI_BASE}/interactions`, {
      method: 'POST',
      headers: { 'x-goog-api-key': key, 'content-type': 'application/json' },
      body: JSON.stringify(
        geminiImageRequest({ prompt: req.prompt, aspectRatio: aspect }, model, inline),
      ),
      signal: req.signal,
    });
    assertMediaAuthorityCurrent(req);
    if (!created.ok) throw await mediaHttpError(created, def.id);
    const output = extractGeminiImage((await created.json()) as Record<string, unknown>);
    assertMediaAuthorityCurrent(req);
    if (!output.data) {
      throw new Error(
        `${def.id}: resposta sem imagem${output.text ? ` — "${output.text}"` : ''}`,
      );
    }
    return Buffer.from(output.data, 'base64');
  }
  const parts: unknown[] = [{ text: req.prompt }];
  if (image) parts.push({ inlineData: fileToInlineData(image) });
  const res = await deps.fetchFn(
    `${GEMINI_BASE}/models/${model}:generateContent`,
    {
      method: 'POST',
      headers: { 'x-goog-api-key': key, 'content-type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts }],
        generationConfig: {
          responseModalities: ['TEXT', 'IMAGE'],
          ...(aspect ? { imageConfig: { aspectRatio: aspect } } : {}),
        },
      }),
      signal: req.signal,
    },
  );
  assertMediaAuthorityCurrent(req);
  if (!res.ok) throw await mediaHttpError(res, def.id);
  const json = (await res.json()) as {
    candidates?: Array<{
      content?: {
        parts?: Array<{ text?: string; inlineData?: { data?: string } }>;
      };
    }>;
  };
  const partsOut = json.candidates?.[0]?.content?.parts ?? [];
  assertMediaAuthorityCurrent(req);
  const inline = partsOut.find((p) => p.inlineData?.data)?.inlineData;
  if (!inline?.data) {
    const text = partsOut
      .map((p) => p.text ?? '')
      .join(' ')
      .trim()
      .slice(0, 200);
    throw new Error(
      `${def.id}: resposta sem imagem${text ? ` — "${text}"` : ''}`,
    );
  }
  return Buffer.from(inline.data, 'base64');
}

async function openaiImage(
  req: ImageRequest,
  def: MediaProviderDef,
  model: string,
  key: string,
  deps: MediaDeps,
  image?: MediaInputFile,
): Promise<Buffer> {
  assertMediaAuthorityCurrent(req);
  const size = openaiImageSize(req.aspectRatio);
  let res: Response;
  if (image) {
    const form = new FormData();
    form.set('model', model);
    form.set('prompt', req.prompt);
    if (size) form.set('size', size);
    form.set(
      'image',
      new Blob([new Uint8Array(image.data)]),
      path.basename(image.path),
    );
    res = await deps.fetchFn(`${OPENAI_BASE}/images/edits`, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}` },
      body: form,
      signal: req.signal,
    });
  } else {
    res = await deps.fetchFn(`${OPENAI_BASE}/images/generations`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${key}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model,
        prompt: req.prompt,
        n: 1,
        ...(size ? { size } : {}),
      }),
      signal: req.signal,
    });
  }
  assertMediaAuthorityCurrent(req);
  if (!res.ok) throw await mediaHttpError(res, def.id);
  const json = (await res.json()) as {
    data?: Array<{ b64_json?: string; url?: string }>;
  };
  assertMediaAuthorityCurrent(req);
  const first = json.data?.[0];
  if (first?.b64_json) return Buffer.from(first.b64_json, 'base64');
  if (first?.url) {
    return downloadProviderAsset(
      first.url,
      'openai-image',
      {
        fetchFn: deps.fetchFn,
        resolveHostname: deps.resolveHostname,
        fetchPinned: deps.fetchPinned,
      },
      undefined,
      req.signal,
    );
  }
  throw new Error(`${def.id}: resposta sem imagem`);
}

/**
 * Seedream (ByteDance image) Replicate input.
 * Official 5.0 Pro: https://seed.bytedance.com/en/seedream5_0_pro
 * Replicate: bytedance/seedream-5-pro (size 1K|2K, image_input 1–10).
 */
export function seedreamInput(
  req: ImageRequest,
  model: string,
  images: MediaInputFile[] = [],
): Record<string, unknown> {
  const isSeedream5 = /seedream-5/.test(model);
  const size = (req.size ?? '2K').trim().toUpperCase();
  if (isSeedream5 && !SEEDREAM5_SIZES.has(size)) {
    throw new Error(
      `Seedream 5.0 Pro size inválido: ${req.size ?? ''} (use 1K ou 2K)`,
    );
  }

  let aspect = req.aspectRatio?.trim() || undefined;
  if (aspect && isSeedream5 && !SEEDREAM5_ASPECTS.has(aspect)) {
    throw new Error(
      `Seedream 5.0 Pro aspectRatio inválido: ${aspect} ` +
        `(use ${[...SEEDREAM5_ASPECTS].join(', ')})`,
    );
  }
  if (!aspect) {
    aspect = images.length === 0 ? '16:9' : 'match_input_image';
  }

  if (images.length > MAX_SEEDREAM_REFERENCE_IMAGES) {
    throw new Error(
      `Seedream aceita no máximo ${MAX_SEEDREAM_REFERENCE_IMAGES} imagens de referência`,
    );
  }

  const prompt = req.prompt.trim();
  if (!prompt) {
    throw new Error('Seedream prompt is required');
  }
  if (prompt.length > 4000) {
    throw new Error('Seedream prompt excede 4000 caracteres');
  }

  const input: Record<string, unknown> = {
    prompt,
    // 5.x: only 1K|2K. Older families may accept other size strings.
    size: isSeedream5 ? size : req.size?.trim() || '2K',
    aspect_ratio: aspect,
    output_format: 'png',
  };
  if (images.length > 0) {
    input.image_input = images.map(dataUri);
  }
  // 4.x extras — only set on older families that declare the field.
  if (model.includes('seedream-4') || model.includes('seedream-3')) {
    input.enhance_prompt = true;
  }
  return input;
}

async function replicateImage(
  req: ImageRequest,
  def: MediaProviderDef,
  model: string,
  key: string,
  deps: MediaDeps,
  images: MediaInputFile[],
): Promise<Buffer> {
  assertMediaAuthorityCurrent(req);
  const create = await deps.fetchFn(
    `${REPLICATE_BASE}/models/${model}/predictions`,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${key}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ input: seedreamInput(req, model, images) }),
      signal: req.signal,
    },
  );
  assertMediaAuthorityCurrent(req);
  if (!create.ok) throw await mediaHttpError(create, def.id);
  const created = (await create.json()) as {
    id?: string;
    status?: string;
    output?: string | string[];
    error?: string;
  };
  assertMediaAuthorityCurrent(req);
  if (!created.id) throw new Error(`${def.id}: prediction sem id`);

  const url = await pollReplicatePrediction(
    created.id,
    key,
    deps,
    created,
    def.id,
    // Image jobs are never persisted — recovery is video-only, so the
    // timeout message must not promise a recoverJobId that cannot work.
    {
      recoverable: false,
      signal: req.signal,
      assertCurrentAuthority: req.assertCurrentAuthority,
    },
  );
  assertMediaAuthorityCurrent(req);
  return downloadProviderAsset(
    url,
    'replicate-image',
    {
      fetchFn: deps.fetchFn,
      resolveHostname: deps.resolveHostname,
      fetchPinned: deps.fetchPinned,
    },
    undefined,
    req.signal,
  );
}

/** Grok Imagine (F-1599): geração, ou edição quando há imagem do projeto. */
async function xaiImage(
  req: ImageRequest,
  def: MediaProviderDef,
  model: string,
  key: string,
  deps: MediaDeps,
  image?: MediaInputFile,
): Promise<XaiImageOutput> {
  const { endpoint, body } = xaiImageRequest(req, model, image ? fileToInlineData(image) : undefined);
  assertMediaAuthorityCurrent(req);
  const res = await deps.fetchFn(`${XAI_API_BASE}/${endpoint}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: req.signal,
  });
  assertMediaAuthorityCurrent(req);
  if (!res.ok) throw await mediaHttpError(res, def.id);
  const output = extractXaiImage((await res.json()) as Record<string, unknown>);
  assertMediaAuthorityCurrent(req);
  return output;
}

export async function generateImage(
  req: ImageRequest,
  deps: MediaDeps = defaultMediaDeps(),
): Promise<MediaGenerationResult> {
  const startedAt = deps.now();
  assertMediaAuthorityCurrent(req);
  const def = resolveMediaProvider(
    'image',
    req.provider,
    (d) => Boolean(deps.getKey(d)),
    req.model,
  );
  const model = resolveMediaModel(def, req.model);
  const key = requireKey(def, deps);
  // A xAI devolve JPEG quando o pedido não diz a qualidade (F-1599).
  const outPath = resolveOutPath(
    req.outPath,
    req.baseDir,
    def.id === 'xai-image' ? 'jpg' : 'png',
    deps.now,
  );
  const image = req.imagePath
    ? readMediaInput(req.imagePath, req.baseDir)
    : undefined;

  // Extra reference images are Seedream-only (image_input array). Reading
  // them for other providers was wasted I/O that silently dropped the
  // capability request — fail loud instead (same contract as the model
  // whitelist).
  const extraRefPaths = req.referenceImagePaths ?? [];
  if (extraRefPaths.length > 0 && def.id !== 'replicate-image' && def.id !== 'higgsfield-image') {
    throw new Error(
      `referenceImagePaths só é suportado em replicate-image (Seedream); ` +
        `${def.id} aceita apenas imagePath (1 imagem de edição)`,
    );
  }
  const seedreamImages =
    def.id === 'replicate-image'
      ? [
          ...(image ? [image] : []),
          ...extraRefPaths
            .slice(0, MAX_SEEDREAM_REFERENCE_IMAGES)
            .map((p) => readMediaInput(p, req.baseDir)),
        ].slice(0, MAX_SEEDREAM_REFERENCE_IMAGES)
      : [];

  let data: Buffer;
  let xai: XaiImageOutput | undefined;
  // F-1613: formato e custo informados pela Higgsfield (cotação do pedido).
  let quoted: { extension: string; costUsd: number | null } | undefined;
  if (def.id === 'higgsfield-image') {
    // A 1ª é a imagem a editar; as outras entram junto (Qwen Image 3: até 3).
    const inputs = [...(image ? [image] : []), ...extraRefPaths.map((p) => readMediaInput(p, req.baseDir))];
    const hf = await generateImageHiggsfield(req, def, model, key, deps, inputs);
    quoted = { extension: hf.extension, costUsd: hf.costUsd };
    data = hf.data;
  } else if (def.id === 'google-image') {
    data = await googleImage(req, def, model, key, deps, image);
  } else if (def.id === 'replicate-image') {
    data = await replicateImage(req, def, model, key, deps, seedreamImages);
  } else if (def.id === 'xai-image') {
    xai = await xaiImage(req, def, model, key, deps, image);
    data = xai.data;
  } else {
    data = await openaiImage(req, def, model, key, deps, image);
  }
  assertMediaAuthorityCurrent(req);
  // O arquivo segue o formato que o serviço devolveu, com outPath ou sem.
  const extension = xai?.extension ?? quoted?.extension;
  const finalPath = extension ? xaiImageOutputPath(outPath, extension) : outPath;
  writeMediaOutput(finalPath, req.baseDir, data);
  const base = result(
    def,
    model,
    finalPath,
    startedAt,
    deps,
    xai ? { resolution: xaiImageResolution(model, req.size), inputImages: image ? 1 : 0 } : {},
  );
  // O custo que a xAI informou (`usage.cost_in_usd_ticks`) vence a tabela.
  if (xai?.costUsd !== undefined) return { ...base, estimatedCostUsd: xai.costUsd };
  return quoted ? { ...base, estimatedCostUsd: quoted.costUsd } : base;
}

// ── Video · Replicate adapters ───────────────────────────────────────────────
// O `input` por família mora em `replicate-video-input.ts` (F-1612).

async function pollReplicatePrediction(
  jobId: string,
  key: string,
  deps: MediaDeps,
  initial?: { status?: string; output?: string | string[]; error?: string },
  providerLabel: string = 'replicate-video',
  opts: {
    recoverable?: boolean;
    signal?: AbortSignal;
    assertCurrentAuthority?: () => void;
  } = {},
): Promise<string> {
  const authority: MediaAuthorityRequest = opts;
  let prediction = {
    id: jobId,
    status: initial?.status,
    output: initial?.output,
    error: initial?.error,
  };
  for (
    let poll = 0;
    prediction.status !== 'succeeded' && poll < REPLICATE_MAX_POLLS;
    poll += 1
  ) {
    assertMediaAuthorityCurrent(authority);
    if (prediction.status === 'failed' || prediction.status === 'canceled') {
      throw new Error(
        `${mediaServiceName(providerLabel)} não concluiu a geração (${prediction.status === 'canceled' ? 'cancelada no serviço' : 'falhou'}): ${prediction.error ?? 'o serviço não informou a causa'}`,
      );
    }
    await sleepWhileAuthorized(deps, REPLICATE_POLL_MS, authority);
    assertMediaAuthorityCurrent(authority);
    const res = await deps.fetchFn(`${REPLICATE_BASE}/predictions/${jobId}`, {
      headers: { authorization: `Bearer ${key}` },
      signal: opts.signal,
    });
    assertMediaAuthorityCurrent(authority);
    if (!res.ok) throw await mediaHttpError(res, providerLabel);
    prediction = (await res.json()) as typeof prediction;
    assertMediaAuthorityCurrent(authority);
  }
  if (prediction.status !== 'succeeded') {
    throw new MediaJobTimeoutError(
      providerLabel,
      jobId,
      opts.recoverable ?? true,
    );
  }
  const url = Array.isArray(prediction.output)
    ? prediction.output[0]
    : prediction.output;
  if (typeof url !== 'string' || !url) {
    throw new Error(`${providerLabel}: prediction sem output`);
  }
  assertMediaAuthorityCurrent(authority);
  return url;
}

async function generateVideoReplicate(
  req: VideoRequest,
  def: MediaProviderDef,
  model: string,
  key: string,
  deps: MediaDeps,
  startedAt: number,
): Promise<MediaGenerationResult> {
  const outPath = resolveOutPath(req.outPath, req.baseDir, 'mp4', deps.now);

  if (req.recoverJobId) {
    assertMediaAuthorityCurrent(req);
    const saved = getVideoJob(req.baseDir, req.recoverJobId);
    if (!saved || saved.provider !== 'replicate-video') {
      throw new Error(
        `job '${req.recoverJobId}' não encontrado em ` +
          `.nexus/media/video-jobs.json`,
      );
    }
    try {
      const url = await pollReplicatePrediction(
        saved.jobId,
        key,
        deps,
        undefined,
        def.id,
        {
          signal: req.signal,
          assertCurrentAuthority: req.assertCurrentAuthority,
        },
      );
      assertMediaAuthorityCurrent(req);
      const data = await downloadProviderAsset(
        url,
        'replicate-video',
        {
          fetchFn: deps.fetchFn,
          resolveHostname: deps.resolveHostname,
          fetchPinned: deps.fetchPinned,
        },
        undefined,
        req.signal,
      );
      assertMediaAuthorityCurrent(req);
      const dest = resolveOutPath(
        req.outPath ?? saved.outPath,
        req.baseDir,
        'mp4',
        deps.now,
      );
      assertMediaAuthorityCurrent(req);
      writeMediaOutput(dest, req.baseDir, data);
      assertMediaAuthorityCurrent(req);
      saveVideoJob(req.baseDir, { ...saved, status: 'completed' });
      return result(
        def,
        saved.model,
        dest,
        startedAt,
        deps,
        {
          seconds:
            savedJobBilling(saved).seconds ??
            req.durationSeconds ??
            videoModelSpec(saved.model)?.defaultDuration,
          resolution:
            savedJobBilling(saved).resolution ??
            req.resolution ??
            videoModelSpec(saved.model)?.defaultResolution,
        },
        saved.jobId,
      );
    } catch (err) {
      assertMediaAuthorityCurrent(req);
      if (err instanceof MediaJobTimeoutError) throw err;
      // Authority is still current here; a revoked/aborted request was
      // normalized by the checkpoint above and left the job pending.
      assertMediaAuthorityCurrent(req);
      saveVideoJob(req.baseDir, { ...saved, status: 'failed' });
      throw err;
    }
  }

  const image = req.imagePath
    ? readMediaInput(req.imagePath, req.baseDir)
    : undefined;
  const endImage = req.endImagePath
    ? readMediaInput(req.endImagePath, req.baseDir)
    : undefined;
  const referenceImages = (req.referenceImagePaths ?? [])
    .slice(0, replicateReferenceLimit(model, MAX_REFERENCE_IMAGES))
    .map((p) => readMediaInput(p, req.baseDir));

  let openaiApiKey: string | undefined;
  if (model.startsWith('openai/sora')) {
    const openaiDef = findMediaProvider('openai-image');
    openaiApiKey = openaiDef ? deps.getKey(openaiDef) : undefined;
    if (!openaiApiKey) {
      throw new Error(
        'O Sora pelo Replicate também exige a chave da OpenAI: conecte ' +
          'OpenAI Image em Ajustes → Serviços de mídia',
      );
    }
  }

  assertMediaAuthorityCurrent(req);
  const create = await deps.fetchFn(
    `${REPLICATE_BASE}/models/${model}/predictions`,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${key}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        input: replicateInput(
          req,
          model,
          image,
          endImage,
          referenceImages,
          openaiApiKey,
        ),
      }),
      signal: req.signal,
    },
  );
  if (!create.ok) throw await mediaHttpError(create, def.id);
  const created = (await create.json()) as {
    id?: string;
    status?: string;
    output?: string | string[];
    error?: string;
  };
  if (!created.id) throw new Error(`${def.id}: prediction sem id`);

  const jobRecord: MediaVideoJobRecord = {
    jobId: created.id,
    provider: 'replicate-video',
    pollTarget: `${REPLICATE_BASE}/predictions/${created.id}`,
    model,
    prompt: req.prompt,
    outPath: req.outPath,
    startedAt: deps.now(),
    status: 'pending',
    ...jobBilling(req),
  };
  // The provider has accepted a billable remote job. Persisting its pending
  // recovery identity is compensating state and must survive a revocation that
  // races the submit response; output/completion/usage still require authority.
  saveVideoJob(req.baseDir, jobRecord);
  assertMediaAuthorityCurrent(req);

  try {
    const url = await pollReplicatePrediction(
      created.id,
      key,
      deps,
      created,
      def.id,
      {
        signal: req.signal,
        assertCurrentAuthority: req.assertCurrentAuthority,
      },
    );
    assertMediaAuthorityCurrent(req);
    const data = await downloadProviderAsset(
      url,
      'replicate-video',
      {
        fetchFn: deps.fetchFn,
        resolveHostname: deps.resolveHostname,
        fetchPinned: deps.fetchPinned,
      },
      undefined,
      req.signal,
    );
    assertMediaAuthorityCurrent(req);
    writeMediaOutput(outPath, req.baseDir, data);
    assertMediaAuthorityCurrent(req);
    saveVideoJob(req.baseDir, { ...jobRecord, status: 'completed' });
    // Modelo que decide a duração (Gemini Omni 1.1, F-1612): o custo sai do arquivo.
    const spec = videoModelSpec(model);
    const picked =
      spec && modelPicksVideoDuration(spec) ? (mp4DurationSeconds(data) ?? undefined) : undefined;
    const done = result(
      def,
      model,
      outPath,
      startedAt,
      deps,
      {
        seconds: req.durationSeconds ?? picked,
        resolution: req.resolution,
      },
      created.id,
    );
    return picked !== undefined ? { ...done, videoDurationSeconds: picked } : done;
  } catch (err) {
    assertMediaAuthorityCurrent(req);
    if (err instanceof MediaJobTimeoutError) throw err;
    assertMediaAuthorityCurrent(req);
    saveVideoJob(req.baseDir, { ...jobRecord, status: 'failed' });
    throw err;
  }
}

// ── Video · Google native Veo ────────────────────────────────────────────────

function googleVeoInstance(
  req: VideoRequest,
  image?: MediaInputFile,
  endImage?: MediaInputFile,
  referenceImages: MediaInputFile[] = [],
): Record<string, unknown> {
  const instance: Record<string, unknown> = { prompt: req.prompt };
  if (image) {
    const { mimeType, data } = fileToInlineData(image);
    instance.image = { bytesBase64Encoded: data, mimeType };
  }
  if (endImage) {
    const { mimeType, data } = fileToInlineData(endImage);
    instance.lastFrame = { bytesBase64Encoded: data, mimeType };
  }
  if (referenceImages.length > 0) {
    instance.referenceImages = referenceImages.map((ref) => {
      const { mimeType, data } = fileToInlineData(ref);
      return { image: { bytesBase64Encoded: data, mimeType } };
    });
  }
  return instance;
}

function googleVeoParameters(req: VideoRequest): Record<string, unknown> {
  const params: Record<string, unknown> = {};
  if (req.aspectRatio) params.aspectRatio = req.aspectRatio;
  if (req.durationSeconds !== undefined) {
    params.durationSeconds = req.durationSeconds;
  }
  if (req.resolution) params.resolution = req.resolution;
  return params;
}

function extractGoogleVeoVideo(operation: Record<string, unknown>): {
  uri?: string;
  bytesBase64?: string;
} {
  const response = operation.response as Record<string, unknown> | undefined;
  const generate =
    (response?.generateVideoResponse as Record<string, unknown> | undefined) ??
    (response?.generate_video_response as
      Record<string, unknown> | undefined) ??
    response;
  const samples =
    (generate?.generatedSamples as unknown[]) ??
    (generate?.generated_samples as unknown[]) ??
    (generate?.videos as unknown[]) ??
    [];
  const first = samples[0] as Record<string, unknown> | undefined;
  const video =
    (first?.video as Record<string, unknown> | undefined) ??
    (first as Record<string, unknown> | undefined);
  if (!video) return {};
  const uri =
    (typeof video.uri === 'string' && video.uri) ||
    (typeof video.gcsUri === 'string' && video.gcsUri) ||
    undefined;
  const bytesBase64 =
    (typeof video.bytesBase64Encoded === 'string' &&
      video.bytesBase64Encoded) ||
    (typeof video.videoBytes === 'string' && video.videoBytes) ||
    undefined;
  return { uri, bytesBase64 };
}

async function pollGoogleVeoOperation(
  operationName: string,
  key: string,
  deps: MediaDeps,
  signal?: AbortSignal,
  assertCurrentAuthority?: () => void,
): Promise<Record<string, unknown>> {
  const authority: MediaAuthorityRequest = {
    signal,
    assertCurrentAuthority,
  };
  // operation.name is like "operations/xyz" — poll relative to GEMINI_BASE.
  const pollPath = operationName.startsWith('http')
    ? operationName
    : `${GEMINI_BASE}/${operationName.replace(/^\//, '')}`;

  let body: Record<string, unknown> = {};
  for (let poll = 0; poll < GOOGLE_VIDEO_MAX_POLLS; poll += 1) {
    assertMediaAuthorityCurrent(authority);
    if (poll > 0) {
      await sleepWhileAuthorized(deps, GOOGLE_VIDEO_POLL_MS, authority);
    }
    assertMediaAuthorityCurrent(authority);
    const res = await deps.fetchFn(pollPath, {
      headers: { 'x-goog-api-key': key },
      signal,
    });
    assertMediaAuthorityCurrent(authority);
    if (!res.ok) throw await mediaHttpError(res, 'google-video');
    body = (await res.json()) as Record<string, unknown>;
    assertMediaAuthorityCurrent(authority);
    if (body.done === true) {
      if (body.error) {
        const err = body.error as { message?: string };
        throw new Error(
          `google-video: operation failed — ${err.message ?? JSON.stringify(body.error).slice(0, 200)}`,
        );
      }
      return body;
    }
  }
  throw new MediaJobTimeoutError('google-video', operationName);
}

async function downloadGoogleVeoBytes(
  extracted: { uri?: string; bytesBase64?: string },
  key: string,
  deps: MediaDeps,
  req: MediaAuthorityRequest,
): Promise<Buffer> {
  assertMediaAuthorityCurrent(req);
  if (extracted.bytesBase64) {
    return Buffer.from(extracted.bytesBase64, 'base64');
  }
  if (!extracted.uri) {
    throw new Error('google-video: operation sem vídeo no response');
  }
  // Signed URIs often work without auth; try with key header as fallback.
  try {
    return await downloadProviderAsset(
      extracted.uri,
      'google-video',
      {
        fetchFn: deps.fetchFn,
        resolveHostname: deps.resolveHostname,
        fetchPinned: deps.fetchPinned,
      },
      undefined,
      req.signal,
    );
  } catch {
    assertMediaAuthorityCurrent(req);
    const res = await deps.fetchFn(extracted.uri, {
      headers: { 'x-goog-api-key': key },
      signal: req.signal,
    });
    assertMediaAuthorityCurrent(req);
    if (!res.ok) throw await mediaHttpError(res, 'google-video');
    const data = Buffer.from(await res.arrayBuffer());
    assertMediaAuthorityCurrent(req);
    return data;
  }
}

// ── Video · Gemini Omni (Interactions API) ───────────────────────────────────
//
// F-1587 — um pedido síncrono (contrato em `gemini-omni-interactions.ts`): o
// vídeo volta na resposta em base64 ou, com `delivery: "uri"` (o recomendado
// acima de 4 MB), como arquivo da Files API que fica ACTIVE e é baixado com a
// chave. Não há campo de duração: o modelo decide.

/** Espera o arquivo da Files API ficar ACTIVE (a documentação manda pollar). */
async function waitGeminiFileActive(
  fileId: string,
  jobId: string,
  key: string,
  deps: MediaDeps,
  req: MediaAuthorityRequest,
): Promise<void> {
  for (let poll = 0; poll < GOOGLE_VIDEO_MAX_POLLS; poll += 1) {
    if (poll > 0) await sleepWhileAuthorized(deps, GOOGLE_VIDEO_POLL_MS, req);
    assertMediaAuthorityCurrent(req);
    const res = await deps.fetchFn(`${GEMINI_BASE}/${fileId}`, {
      headers: { 'x-goog-api-key': key },
      signal: req.signal,
    });
    assertMediaAuthorityCurrent(req);
    if (res.status === 404) {
      const gone = await mediaHttpError(res, 'google-video');
      throw new MediaJobGoneError(
        `O arquivo do vídeo não existe mais na Files API do Google (HTTP 404); gere de novo.${
          gone.detail ? ` Resposta do serviço: ${gone.detail}` : ''
        }`,
      );
    }
    if (!res.ok) throw await mediaHttpError(res, 'google-video');
    const file = (await res.json()) as { state?: unknown; error?: { message?: unknown } };
    assertMediaAuthorityCurrent(req);
    if (file.state === undefined || file.state === 'ACTIVE') return;
    if (file.state === 'FAILED') {
      const message = typeof file.error?.message === 'string' ? ` — ${file.error.message}` : '';
      throw new MediaJobGoneError(
        `O Google não concluiu o arquivo do vídeo (Files API: FAILED)${message}.`,
      );
    }
  }
  throw new MediaJobTimeoutError('google-video', jobId);
}

async function downloadGeminiOmniFile(
  fileId: string,
  jobId: string,
  key: string,
  deps: MediaDeps,
  req: MediaAuthorityRequest,
): Promise<Buffer> {
  await waitGeminiFileActive(fileId, jobId, key, deps, req);
  assertMediaAuthorityCurrent(req);
  // A URL é montada aqui a partir do id; a chave nunca vai para uma URL que
  // veio da resposta.
  const data = await downloadAuthenticatedProviderAsset(
    `${GEMINI_BASE}/${fileId}:download?alt=media`,
    'google-video',
    { host: GEMINI_HOST, headers: { 'x-goog-api-key': key } },
    {
      fetchFn: deps.fetchFn,
      resolveHostname: deps.resolveHostname,
      fetchPinned: deps.fetchPinned,
    },
    req.signal,
  );
  assertMediaAuthorityCurrent(req);
  return data;
}

/**
 * Custo do que o Google cobrou (`usage`) quando a resposta traz os tokens;
 * sem eles (retomada pela Files API), a tabela por segundo com a duração
 * lida do MP4.
 */
function omniResult(
  def: MediaProviderDef,
  model: string,
  outPath: string,
  startedAt: number,
  deps: MediaDeps,
  data: Buffer,
  billing: { resolution?: string; jobId?: string; usage?: GeminiOmniUsage },
): MediaGenerationResult {
  const seconds = mp4DurationSeconds(data) ?? undefined;
  const base = result(
    def,
    model,
    outPath,
    startedAt,
    deps,
    { seconds, resolution: billing.resolution },
    billing.jobId,
  );
  return {
    ...base,
    ...(billing.usage ? { estimatedCostUsd: geminiOmniCostUsd(billing.usage) } : {}),
    ...(seconds !== undefined ? { videoDurationSeconds: seconds } : {}),
  };
}

async function generateVideoGeminiOmni(
  req: VideoRequest,
  def: MediaProviderDef,
  model: string,
  key: string,
  deps: MediaDeps,
  startedAt: number,
): Promise<MediaGenerationResult> {
  const outPath = resolveOutPath(req.outPath, req.baseDir, 'mp4', deps.now);
  const inline = (file: string) => fileToInlineData(readMediaInput(file, req.baseDir));
  const body = geminiOmniRequest(req, model, {
    start: req.imagePath ? inline(req.imagePath) : undefined,
    end: req.endImagePath ? inline(req.endImagePath) : undefined,
    references: (req.referenceImagePaths ?? []).slice(0, MAX_REFERENCE_IMAGES).map(inline),
  });

  assertMediaAuthorityCurrent(req);
  let create: Response;
  try {
    create = await deps.fetchFn(`${GEMINI_BASE}/interactions`, {
      method: 'POST',
      headers: { 'x-goog-api-key': key, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: req.signal,
    });
  } catch (err) {
    assertMediaAuthorityCurrent(req);
    throw geminiOmniTransportError(err);
  }
  assertMediaAuthorityCurrent(req);
  if (!create.ok) throw await mediaHttpError(create, def.id);
  const output = extractGeminiOmniOutput((await create.json()) as Record<string, unknown>);
  assertMediaAuthorityCurrent(req);

  if (output.data) {
    const data = Buffer.from(output.data, 'base64');
    writeMediaOutput(outPath, req.baseDir, data);
    assertMediaAuthorityCurrent(req);
    return omniResult(def, model, outPath, startedAt, deps, data, {
      resolution: req.resolution,
      usage: output.usage,
    });
  }
  if (output.uri) {
    const data = await downloadProviderAsset(
      output.uri,
      'google-video',
      { fetchFn: deps.fetchFn, resolveHostname: deps.resolveHostname, fetchPinned: deps.fetchPinned },
      undefined,
      req.signal,
    );
    assertMediaAuthorityCurrent(req);
    writeMediaOutput(outPath, req.baseDir, data);
    assertMediaAuthorityCurrent(req);
    return omniResult(def, model, outPath, startedAt, deps, data, {
      resolution: req.resolution,
      usage: output.usage,
    });
  }
  if (!output.fileId) {
    const status = output.status && output.status !== 'completed' ? ` (status: ${output.status})` : '';
    const said = output.text ? ` O modelo respondeu: "${output.text}"` : '';
    throw new Error(`O Google não devolveu vídeo${status}; nada foi salvo.${said}`);
  }

  // O vídeo já foi gerado (e cobrado): o id do arquivo fica salvo para
  // `recoverJobId` antes de esperar a Files API.
  const jobRecord: MediaVideoJobRecord = {
    jobId: output.interactionId ?? output.fileId,
    provider: 'google-video',
    pollTarget: output.fileId,
    model,
    prompt: req.prompt,
    outPath: req.outPath,
    startedAt: deps.now(),
    status: 'pending',
    ...jobBilling(req),
    ...(output.usage ? { usage: output.usage } : {}),
  };
  saveVideoJob(req.baseDir, jobRecord);
  assertMediaAuthorityCurrent(req);
  const fileId = output.fileId;
  return settleVideoJob(jobRecord, req, async () => {
    const data = await downloadGeminiOmniFile(fileId, jobRecord.jobId, key, deps, req);
    writeMediaOutput(outPath, req.baseDir, data);
    assertMediaAuthorityCurrent(req);
    saveVideoJob(req.baseDir, { ...jobRecord, status: 'completed' });
    return omniResult(def, model, outPath, startedAt, deps, data, {
      resolution: req.resolution,
      jobId: jobRecord.jobId,
      usage: output.usage,
    });
  });
}

async function generateVideoGoogle(
  req: VideoRequest,
  def: MediaProviderDef,
  model: string,
  key: string,
  deps: MediaDeps,
  startedAt: number,
): Promise<MediaGenerationResult> {
  const outPath = resolveOutPath(req.outPath, req.baseDir, 'mp4', deps.now);

  if (req.recoverJobId) {
    assertMediaAuthorityCurrent(req);
    const saved = getVideoJob(req.baseDir, req.recoverJobId);
    if (!saved || saved.provider !== 'google-video') {
      throw new Error(
        `job '${req.recoverJobId}' não encontrado em ` +
          `.nexus/media/video-jobs.json`,
      );
    }
    if (isGeminiFileTarget(saved.pollTarget)) {
      // Gemini Omni: o vídeo já existe na Files API; só falta baixar. O custo
      // é o do que foi gerado: `usage` e resolução salvos no job.
      return settleVideoJob(saved, req, async () => {
        const data = await downloadGeminiOmniFile(saved.pollTarget, saved.jobId, key, deps, req);
        const dest = resolveOutPath(req.outPath ?? saved.outPath, req.baseDir, 'mp4', deps.now);
        writeMediaOutput(dest, req.baseDir, data);
        assertMediaAuthorityCurrent(req);
        saveVideoJob(req.baseDir, { ...saved, status: 'completed' });
        return omniResult(def, saved.model, dest, startedAt, deps, data, {
          resolution: savedJobBilling(saved).resolution ?? req.resolution,
          jobId: saved.jobId,
          usage: isGeminiOmniUsage(saved.usage) ? saved.usage : undefined,
        });
      });
    }
    try {
      const done = await pollGoogleVeoOperation(
        saved.pollTarget,
        key,
        deps,
        req.signal,
        req.assertCurrentAuthority,
      );
      assertMediaAuthorityCurrent(req);
      const extracted = extractGoogleVeoVideo(done);
      const data = await downloadGoogleVeoBytes(extracted, key, deps, req);
      assertMediaAuthorityCurrent(req);
      const dest = resolveOutPath(
        req.outPath ?? saved.outPath,
        req.baseDir,
        'mp4',
        deps.now,
      );
      assertMediaAuthorityCurrent(req);
      writeMediaOutput(dest, req.baseDir, data);
      assertMediaAuthorityCurrent(req);
      saveVideoJob(req.baseDir, { ...saved, status: 'completed' });
      return result(
        def,
        saved.model,
        dest,
        startedAt,
        deps,
        {
          seconds:
            savedJobBilling(saved).seconds ??
            req.durationSeconds ??
            videoModelSpec(saved.model)?.defaultDuration,
          resolution:
            savedJobBilling(saved).resolution ??
            req.resolution ??
            videoModelSpec(saved.model)?.defaultResolution,
        },
        saved.jobId,
      );
    } catch (err) {
      assertMediaAuthorityCurrent(req);
      if (err instanceof MediaJobTimeoutError) throw err;
      assertMediaAuthorityCurrent(req);
      saveVideoJob(req.baseDir, { ...saved, status: 'failed' });
      throw err;
    }
  }

  if (!req.prompt?.trim()) {
    throw new Error('google-video: prompt is required');
  }
  if (isGeminiOmniModel(model)) {
    return generateVideoGeminiOmni(req, def, model, key, deps, startedAt);
  }

  const image = req.imagePath
    ? readMediaInput(req.imagePath, req.baseDir)
    : undefined;
  const endImage = req.endImagePath
    ? readMediaInput(req.endImagePath, req.baseDir)
    : undefined;
  const referenceImages = (req.referenceImagePaths ?? [])
    .slice(0, MAX_REFERENCE_IMAGES)
    .map((p) => readMediaInput(p, req.baseDir));

  assertMediaAuthorityCurrent(req);
  const submit = await deps.fetchFn(
    `${GEMINI_BASE}/models/${model}:predictLongRunning`,
    {
      method: 'POST',
      headers: {
        'x-goog-api-key': key,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        instances: [googleVeoInstance(req, image, endImage, referenceImages)],
        parameters: googleVeoParameters(req),
      }),
      signal: req.signal,
    },
  );
  if (!submit.ok) throw await mediaHttpError(submit, def.id);
  const started = (await submit.json()) as { name?: string };
  if (!started.name) {
    throw new Error('google-video: operation sem name');
  }

  const jobRecord: MediaVideoJobRecord = {
    jobId: started.name,
    provider: 'google-video',
    pollTarget: started.name,
    model,
    prompt: req.prompt,
    outPath: req.outPath,
    startedAt: deps.now(),
    status: 'pending',
    ...jobBilling(req),
  };
  // Recovery identity is compensating state for an already-submitted remote
  // operation; keep it pending even if authority disappears immediately after.
  saveVideoJob(req.baseDir, jobRecord);
  assertMediaAuthorityCurrent(req);

  try {
    const done = await pollGoogleVeoOperation(
      started.name,
      key,
      deps,
      req.signal,
      req.assertCurrentAuthority,
    );
    assertMediaAuthorityCurrent(req);
    const extracted = extractGoogleVeoVideo(done);
    const data = await downloadGoogleVeoBytes(extracted, key, deps, req);
    assertMediaAuthorityCurrent(req);
    writeMediaOutput(outPath, req.baseDir, data);
    assertMediaAuthorityCurrent(req);
    saveVideoJob(req.baseDir, { ...jobRecord, status: 'completed' });
    return result(
      def,
      model,
      outPath,
      startedAt,
      deps,
      {
        seconds: req.durationSeconds,
        resolution: req.resolution,
      },
      started.name,
    );
  } catch (err) {
    assertMediaAuthorityCurrent(req);
    if (err instanceof MediaJobTimeoutError) throw err;
    assertMediaAuthorityCurrent(req);
    saveVideoJob(req.baseDir, { ...jobRecord, status: 'failed' });
    throw err;
  }
}

// ── Video · xAI Grok Imagine (F-1599) ────────────────────────────────────────
//
// `POST /v1/videos/generations` devolve só o `request_id` (job salvo para
// `recoverJobId`); o `GET /v1/videos/{id}` é pollado até `done` e o MP4 vem de
// uma URL temporária e pública em `vidgen.x.ai`, baixada sem a chave.

async function finishXaiVideo(
  job: MediaVideoJobRecord,
  outPath: string,
  req: VideoRequest,
  def: MediaProviderDef,
  key: string,
  deps: MediaDeps,
  startedAt: number,
): Promise<MediaGenerationResult> {
  return settleVideoJob(job, req, async () => {
    let poll: XaiVideoPoll = { state: 'pending' };
    for (let attempt = 0; poll.state === 'pending'; attempt += 1) {
      if (attempt >= XAI_VIDEO_MAX_POLLS) throw new MediaJobTimeoutError(def.id, job.jobId);
      await sleepWhileAuthorized(deps, XAI_VIDEO_POLL_MS, req);
      const res = await deps.fetchFn(xaiVideoPollUrl(job.pollTarget), {
        headers: { authorization: `Bearer ${key}` },
        signal: req.signal,
      });
      assertMediaAuthorityCurrent(req);
      if (res.status === 404) {
        const gone = await mediaHttpError(res, def.id);
        throw new MediaJobGoneError(
          `A xAI não conhece mais este pedido de vídeo (HTTP 404); gere de novo.${
            gone.detail ? ` Resposta do serviço: ${gone.detail}` : ''
          }`,
        );
      }
      if (!res.ok) throw await mediaHttpError(res, def.id);
      poll = readXaiVideoPoll((await res.json()) as Record<string, unknown>);
      assertMediaAuthorityCurrent(req);
    }
    if (poll.state === 'failed') throw new MediaJobGoneError(poll.problem);
    const data = await downloadProviderAsset(
      poll.url,
      'xai-video',
      { fetchFn: deps.fetchFn, resolveHostname: deps.resolveHostname, fetchPinned: deps.fetchPinned },
      undefined,
      req.signal,
    );
    assertMediaAuthorityCurrent(req);
    writeMediaOutput(outPath, req.baseDir, data);
    assertMediaAuthorityCurrent(req);
    saveVideoJob(req.baseDir, { ...job, status: 'completed' });
    // Retomada só com o id: a resolução e a duração pedidas vêm do job salvo.
    const billing = savedJobBilling(job);
    const spec = videoModelSpec(job.model);
    const seconds =
      poll.durationSeconds ?? billing.seconds ?? req.durationSeconds ?? spec?.defaultDuration;
    const resolution = billing.resolution ?? req.resolution ?? spec?.defaultResolution;
    const inputImages = billing.inputImages ?? videoInputImageCount(req);
    const base = result(
      def,
      job.model,
      outPath,
      startedAt,
      deps,
      { seconds, resolution, inputImages },
      job.jobId,
    );
    return poll.costUsd !== undefined ? { ...base, estimatedCostUsd: poll.costUsd } : base;
  });
}

async function generateVideoXai(
  req: VideoRequest,
  def: MediaProviderDef,
  model: string,
  key: string,
  deps: MediaDeps,
  startedAt: number,
): Promise<MediaGenerationResult> {
  if (req.recoverJobId) {
    assertMediaAuthorityCurrent(req);
    const saved = getVideoJob(req.baseDir, req.recoverJobId);
    if (!saved || saved.provider !== 'xai-video') {
      throw new Error(`job '${req.recoverJobId}' não encontrado em .nexus/media/video-jobs.json`);
    }
    const dest = resolveOutPath(req.outPath ?? saved.outPath, req.baseDir, 'mp4', deps.now);
    return finishXaiVideo(saved, dest, req, def, key, deps, startedAt);
  }

  const outPath = resolveOutPath(req.outPath, req.baseDir, 'mp4', deps.now);
  const references = req.referenceImagePaths ?? [];
  const problem = xaiVideoInputProblem(model, {
    hasImage: Boolean(req.imagePath),
    hasEndImage: Boolean(req.endImagePath),
    referenceCount: references.length,
    resolution: req.resolution,
    durationSeconds: req.durationSeconds,
  });
  if (problem) throw new Error(problem);
  const inline = (file: string) => fileToInlineData(readMediaInput(file, req.baseDir));
  const body = xaiVideoRequest(req, model, {
    start: req.imagePath ? inline(req.imagePath) : undefined,
    end: req.endImagePath ? inline(req.endImagePath) : undefined,
    references: references.map(inline),
  });

  assertMediaAuthorityCurrent(req);
  const create = await deps.fetchFn(`${XAI_API_BASE}/videos/generations`, {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: req.signal,
  });
  if (!create.ok) throw await mediaHttpError(create, def.id);
  const requestId = xaiRequestId(await create.json());
  const job: MediaVideoJobRecord = {
    jobId: requestId,
    provider: 'xai-video',
    pollTarget: requestId,
    model,
    prompt: req.prompt,
    outPath: req.outPath,
    startedAt: deps.now(),
    status: 'pending',
    ...jobBilling(req),
  };
  // Job aceito e cobrável: a identidade de retomada fica salva mesmo que a
  // autoridade caia logo depois (mesma regra do Replicate e do Google).
  saveVideoJob(req.baseDir, job);
  assertMediaAuthorityCurrent(req);
  return finishXaiVideo(job, outPath, req, def, key, deps, startedAt);
}

export async function generateVideo(
  req: VideoRequest,
  deps: MediaDeps = defaultMediaDeps(),
): Promise<MediaGenerationResult> {
  const startedAt = deps.now();
  assertMediaAuthorityCurrent(req);

  // recoverJobId may imply provider from the saved job.
  let providerId = req.provider;
  if (req.recoverJobId && !providerId) {
    const saved = getVideoJob(req.baseDir, req.recoverJobId);
    if (saved) providerId = saved.provider;
  }

  const def = resolveMediaProvider(
    'video',
    providerId,
    (d) => Boolean(deps.getKey(d)),
    req.model,
  );
  const model = req.recoverJobId
    ? (getVideoJob(req.baseDir, req.recoverJobId)?.model ??
      resolveMediaModel(def, req.model))
    : resolveMediaModel(def, req.model);
  // Só o Grok Imagine gera vídeo sem texto (a partir de imagem; o contrato da
  // xAI decide). Os outros recusam aqui, antes de chamar o serviço.
  if (!req.recoverJobId && !req.prompt?.trim() && def.id !== 'xai-video') {
    throw new Error(
      `${def.label}: informe o texto do vídeo (prompt). Só o Grok Imagine (xai-video) gera vídeo sem texto, a partir de imagem.`,
    );
  }
  // F-1585: o que o modelo recusa é recusado aqui, antes de qualquer chamada
  // paga, com a frase do que ele aceita; o que não veio usa o padrão DELE.
  let effective = req;
  if (!req.recoverJobId) {
    const problem = videoRequestProblem(
      model,
      {
        durationSeconds: req.durationSeconds,
        resolution: req.resolution,
        aspectRatio: req.aspectRatio,
        hasImage: Boolean(req.imagePath),
        referenceImages: req.referenceImagePaths?.length ?? 0,
        referenceVideos: req.referenceVideoPaths?.length ?? 0,
      },
      deps.now(),
    );
    if (problem) throw new Error(problem);
    const spec = videoModelSpec(model);
    if (spec) {
      effective = {
        ...req,
        durationSeconds: req.durationSeconds ?? spec.defaultDuration,
        resolution:
          req.resolution ?? (spec.resolutions.length > 0 ? spec.defaultResolution : undefined),
      };
    }
  }
  const key = requireKey(def, deps);

  if (def.id === 'google-video') {
    return generateVideoGoogle(effective, def, model, key, deps, startedAt);
  }
  if (def.id === 'xai-video') {
    return generateVideoXai(effective, def, model, key, deps, startedAt);
  }
  if (def.id === 'higgsfield-video') {
    return generateVideoHiggsfield(effective, def, model, key, deps, startedAt);
  }
  return generateVideoReplicate(effective, def, model, key, deps, startedAt);
}

// ── Audio ────────────────────────────────────────────────────────────────────

export async function generateAudio(
  req: AudioRequest,
  deps: MediaDeps = defaultMediaDeps(),
): Promise<MediaGenerationResult> {
  const startedAt = deps.now();
  assertMediaAuthorityCurrent(req);
  const def = resolveMediaProvider('audio', req.provider, (d) =>
    Boolean(deps.getKey(d)),
  );
  const model = resolveMediaModel(def, req.model);
  const key = requireKey(def, deps);
  const voiceId = req.voiceId ?? DEFAULT_ELEVENLABS_VOICE;
  const outPath = resolveOutPath(req.outPath, req.baseDir, 'mp3', deps.now);

  assertMediaAuthorityCurrent(req);
  const res = await deps.fetchFn(
    `${ELEVENLABS_BASE}/text-to-speech/${encodeURIComponent(voiceId)}`,
    {
      method: 'POST',
      headers: { 'xi-api-key': key, 'content-type': 'application/json' },
      body: JSON.stringify({ text: req.text, model_id: model }),
      signal: req.signal,
    },
  );
  assertMediaAuthorityCurrent(req);
  if (!res.ok) throw await mediaHttpError(res, def.id);

  const data = Buffer.from(await res.arrayBuffer());
  assertMediaAuthorityCurrent(req);
  writeMediaOutput(outPath, req.baseDir, data);
  return result(def, model, outPath, startedAt, deps, {
    chars: req.text.length,
  });
}

// ── Default deps (electron edge) ─────────────────────────────────────────────

function defaultMediaDeps(): MediaDeps {
  // Lazy require keeps this module importable from unit tests (no electron).
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { resolveMediaKey } =
    require('./media-keys') as typeof import('./media-keys');
  return {
    fetchFn: fetch,
    resolveHostname: resolveBrowserHostname,
    fetchPinned: fetchPinnedProviderAsset,
    getKey: (def) => resolveMediaKey(def),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: Date.now,
  };
}
