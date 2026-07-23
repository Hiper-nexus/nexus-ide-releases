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
  downloadProviderAsset,
  fetchPinnedProviderAsset,
  type PinnedMediaFetch,
} from './media-download';
import {
  readMediaInput,
  writeMediaOutput,
  type MediaInputFile,
} from './media-path-policy';
import type { BrowserAddressResolver } from '../browser/url-policy';
import { geminiImageAspect, openaiImageSize } from './media-aspect';
import {
  getVideoJob,
  saveVideoJob,
  type MediaVideoJobRecord,
} from './media-video-jobs';

/**
 * Media generation engine — image (Gemini/OpenAI), video (Replicate + native
 * Google Veo) and audio (ElevenLabs). Runs entirely in main: the API key never
 * crosses the MCP boundary; the agent receives only the generated file path.
 *
 * All network/clock/key access is injected via MediaDeps so the engine is
 * unit-testable without electron or real HTTP.
 */

export interface MediaDeps {
  fetchFn: typeof fetch;
  resolveHostname: BrowserAddressResolver;
  fetchPinned?: PinnedMediaFetch;
  getKey(def: MediaProviderDef): string | undefined;
  sleep(ms: number): Promise<void>;
  now(): number;
}

const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta';
const OPENAI_BASE = 'https://api.openai.com/v1';
const REPLICATE_BASE = 'https://api.replicate.com/v1';
const ELEVENLABS_BASE = 'https://api.elevenlabs.io/v1';

const REPLICATE_POLL_MS = 4_000;
const REPLICATE_MAX_POLLS = 90; // 6 min
const GOOGLE_VIDEO_POLL_MS = 5_000;
const GOOGLE_VIDEO_MAX_POLLS = 72; // 6 min
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

/**
 * Timeout on a long-running Replicate/Google media job (image or video).
 * `recoverable` controls whether the message promises resume via recoverJobId
 * — only video jobs are persisted, so only they may advertise recovery.
 */
export class MediaJobTimeoutError extends Error {
  readonly jobId: string;
  readonly provider: string;
  readonly recoverable: boolean;

  constructor(provider: string, jobId: string, recoverable = true) {
    super(
      recoverable
        ? `${provider}: timeout esperando job ${jobId} — chame de novo com ` +
            `recoverJobId="${jobId}" para retomar sem pagar duas vezes`
        : `${provider}: timeout esperando job ${jobId} — a prediction pode ` +
            'ter completado no provider; reenvie a geração',
    );
    this.name = 'MediaJobTimeoutError';
    this.jobId = jobId;
    this.provider = provider;
    this.recoverable = recoverable;
  }
}

/** Local abort (mission preempt / Estúdio cancel button) — not an error. */
export class MediaAbortError extends Error {
  constructor() {
    super('geração de mídia cancelada');
    this.name = 'MediaAbortError';
  }
}

export function throwIfMediaAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new MediaAbortError();
}

interface MediaAuthorityRequest {
  /** Aborted on caller/mission revocation. */
  signal?: AbortSignal;
  /** Revalidates non-signal authority (PREVC/scope/intent) at commit points. */
  assertCurrentAuthority?: () => void;
}

function assertMediaAuthorityCurrent(req: MediaAuthorityRequest): void {
  req.assertCurrentAuthority?.();
  throwIfMediaAborted(req.signal);
}

async function sleepWhileAuthorized(
  deps: MediaDeps,
  delayMs: number,
  req: MediaAuthorityRequest,
): Promise<void> {
  assertMediaAuthorityCurrent(req);
  if (!req.signal) {
    await deps.sleep(delayMs);
    assertMediaAuthorityCurrent(req);
    return;
  }
  let rejectAbort!: (reason: MediaAbortError) => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject;
  });
  const onAbort = () => rejectAbort(new MediaAbortError());
  req.signal.addEventListener('abort', onAbort, { once: true });
  try {
    await Promise.race([deps.sleep(delayMs), aborted]);
  } finally {
    req.signal.removeEventListener('abort', onAbort);
  }
  assertMediaAuthorityCurrent(req);
}

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

function requireKey(def: MediaProviderDef, deps: MediaDeps): string {
  const key = deps.getKey(def);
  if (!key) {
    throw new Error(
      `provider ${def.id} sem key — configure em Settings → Mídia`,
    );
  }
  return key;
}

async function httpError(res: Response, provider: string): Promise<Error> {
  let detail = '';
  try {
    detail = (await res.text()).slice(0, 400);
  } catch {
    // corpo ilegível — o status já identifica a falha
  }
  return new Error(`${provider} HTTP ${res.status}: ${detail}`);
}

function fileToInlineData(image: MediaInputFile): {
  mimeType: string;
  data: string;
} {
  const ext = path.extname(image.path).toLowerCase().replace('.', '');
  const mime =
    ext === 'jpg' || ext === 'jpeg'
      ? 'image/jpeg'
      : ext === 'webp'
        ? 'image/webp'
        : `image/${ext || 'png'}`;
  return { mimeType: mime, data: image.data.toString('base64') };
}

function dataUri(image: MediaInputFile): string {
  const { mimeType, data } = fileToInlineData(image);
  return `data:${mimeType};base64,${data}`;
}

function result(
  def: MediaProviderDef,
  model: string,
  outPath: string,
  startedAt: number,
  deps: MediaDeps,
  costParams: { chars?: number; seconds?: number } = {},
  jobId?: string,
): MediaGenerationResult {
  return {
    ok: true,
    path: outPath,
    provider: def.id,
    model,
    kind: def.kind,
    estimatedCostUsd: def.estimateCost({ model, ...costParams }),
    durationMs: deps.now() - startedAt,
    ...(jobId ? { jobId } : {}),
  };
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
  const parts: unknown[] = [{ text: req.prompt }];
  if (image) parts.push({ inlineData: fileToInlineData(image) });
  const aspect = geminiImageAspect(req.aspectRatio);
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
  if (!res.ok) throw await httpError(res, def.id);
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
  if (!res.ok) throw await httpError(res, def.id);
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
  if (!create.ok) throw await httpError(create, def.id);
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
  const outPath = resolveOutPath(req.outPath, req.baseDir, 'png', deps.now);
  const image = req.imagePath
    ? readMediaInput(req.imagePath, req.baseDir)
    : undefined;

  // Extra reference images are Seedream-only (image_input array). Reading
  // them for other providers was wasted I/O that silently dropped the
  // capability request — fail loud instead (same contract as the model
  // whitelist).
  const extraRefPaths = req.referenceImagePaths ?? [];
  if (extraRefPaths.length > 0 && def.id !== 'replicate-image') {
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
  if (def.id === 'google-image') {
    data = await googleImage(req, def, model, key, deps, image);
  } else if (def.id === 'replicate-image') {
    data = await replicateImage(req, def, model, key, deps, seedreamImages);
  } else {
    data = await openaiImage(req, def, model, key, deps, image);
  }
  assertMediaAuthorityCurrent(req);
  writeMediaOutput(outPath, req.baseDir, data);
  return result(def, model, outPath, startedAt, deps);
}

// ── Video · Replicate adapters ───────────────────────────────────────────────

/**
 * Image-to-video input FIELD NAME differs by Replicate model family. Passing
 * the wrong one drops the first frame silently. Verified against live OpenAPI
 * schemas (2026-07) and the Overclock mediaGeneration adapter.
 */
export function replicateImageField(model: string): string {
  if (model.startsWith('kwaivgi/kling')) return 'start_image';
  if (
    model.startsWith('minimax/hailuo') ||
    model.startsWith('minimax/video-01')
  ) {
    return 'first_frame_image';
  }
  if (model.startsWith('luma/')) return 'start_image';
  if (model.startsWith('openai/sora')) return 'input_reference';
  // seedance, veo, runway, wan-video, default
  return 'image';
}

/** End / last-frame field when the family supports keyframe interpolation. */
export function replicateEndImageField(model: string): string | null {
  if (model.startsWith('kwaivgi/kling')) return 'end_image';
  if (model.startsWith('bytedance/seedance')) return 'last_frame_image';
  if (model.startsWith('google/veo')) return 'last_frame';
  if (model.startsWith('luma/')) return 'end_image';
  return null;
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
  const isKling = model.startsWith('kwaivgi/kling');
  const isHailuo = model.startsWith('minimax/hailuo');
  const isSora = model.startsWith('openai/sora');
  const isRunway = model.startsWith('runwayml/');
  const isLuma = model.startsWith('luma/');

  const input: Record<string, unknown> = { prompt: req.prompt };

  if (isSeedance || isVeo) {
    input.duration = req.durationSeconds ?? 5;
    input.resolution = req.resolution ?? '720p';
    input.aspect_ratio = req.aspectRatio ?? '16:9';
    if (!(isVeo && model.endsWith('-lite'))) {
      input.generate_audio = true;
    }
  } else if (isKling) {
    if (req.durationSeconds !== undefined) input.duration = req.durationSeconds;
    if (req.aspectRatio) input.aspect_ratio = req.aspectRatio;
    if (req.resolution === '720p') input.mode = 'standard';
    else if (req.resolution === '1080p') input.mode = 'pro';
    else if (req.resolution === '4k') input.mode = '4k';
  } else if (isHailuo) {
    if (req.durationSeconds !== undefined) input.duration = req.durationSeconds;
    if (req.resolution) input.resolution = req.resolution;
  } else if (isSora) {
    // Sora uses `seconds` not duration; may require the caller's OpenAI key.
    input.seconds = req.durationSeconds ?? 4;
    if (req.aspectRatio) input.aspect_ratio = req.aspectRatio;
    if (req.resolution && model.includes('pro')) {
      input.resolution = req.resolution;
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
  if (isSeedance && referenceImages.length > 0 && (image || endImage)) {
    throw new Error(
      'Seedance: reference_images não pode combinar com imagePath/endImagePath — use um ou outro',
    );
  }
  // Seedance / Veo reference images (character consistency).
  if (referenceImages.length > 0 && (isSeedance || isVeo)) {
    input.reference_images = referenceImages.map(dataUri);
  }

  return input;
}

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
        `${providerLabel}: prediction ${prediction.status} — ${prediction.error ?? 'sem causa'}`,
      );
    }
    await sleepWhileAuthorized(deps, REPLICATE_POLL_MS, authority);
    assertMediaAuthorityCurrent(authority);
    const res = await deps.fetchFn(`${REPLICATE_BASE}/predictions/${jobId}`, {
      headers: { authorization: `Bearer ${key}` },
      signal: opts.signal,
    });
    assertMediaAuthorityCurrent(authority);
    if (!res.ok) throw await httpError(res, providerLabel);
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
          seconds: req.durationSeconds ?? 5,
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
    .slice(0, MAX_REFERENCE_IMAGES)
    .map((p) => readMediaInput(p, req.baseDir));

  let openaiApiKey: string | undefined;
  if (model.startsWith('openai/sora')) {
    const openaiDef = findMediaProvider('openai-image');
    openaiApiKey = openaiDef ? deps.getKey(openaiDef) : undefined;
    if (!openaiApiKey) {
      throw new Error(
        'openai/sora exige OPENAI_API_KEY (Settings → Mídia → OpenAI Image) ' +
          'além do token Replicate',
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
  if (!create.ok) throw await httpError(create, def.id);
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
    return result(
      def,
      model,
      outPath,
      startedAt,
      deps,
      {
        seconds: req.durationSeconds ?? 5,
      },
      created.id,
    );
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
    if (!res.ok) throw await httpError(res, 'google-video');
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
    if (!res.ok) throw await httpError(res, 'google-video');
    const data = Buffer.from(await res.arrayBuffer());
    assertMediaAuthorityCurrent(req);
    return data;
  }
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
          seconds: req.durationSeconds ?? 8,
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
  if (!submit.ok) throw await httpError(submit, def.id);
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
        seconds: req.durationSeconds ?? 8,
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
  const key = requireKey(def, deps);

  if (def.id === 'google-video') {
    return generateVideoGoogle(req, def, model, key, deps, startedAt);
  }
  return generateVideoReplicate(req, def, model, key, deps, startedAt);
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
  if (!res.ok) throw await httpError(res, def.id);

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
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { resolveBrowserHostname } =
    require('../browser/url-policy') as typeof import('../browser/url-policy');
  return {
    fetchFn: fetch,
    resolveHostname: resolveBrowserHostname,
    fetchPinned: fetchPinnedProviderAsset,
    getKey: (def) => resolveMediaKey(def),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: Date.now,
  };
}
