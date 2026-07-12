import path from 'node:path';
import type { MediaGenerationResult } from '../../shared/media-types';
import {
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

/**
 * Media generation engine — image (Gemini/OpenAI), video (Replicate) and
 * audio (ElevenLabs). Runs entirely in main: the API key never crosses the
 * MCP boundary; the agent receives only the generated file's path.
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
const DEFAULT_ELEVENLABS_VOICE = '21m00Tcm4TlvDq8ikWAM'; // Rachel

export interface ImageRequest {
  prompt: string;
  provider?: string;
  model?: string;
  /** Absolute, or relative to baseDir (must not escape it). */
  outPath?: string;
  baseDir: string;
  /** Existing image for image-to-image edits. */
  imagePath?: string;
}

export interface VideoRequest {
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
  /** End keyframe (Kling 2-keyframe interpolation). */
  endImagePath?: string;
}

export interface AudioRequest {
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
    throw new Error(`provider ${def.id} sem key — configure em Settings → Mídia`);
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
  const mime = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : `image/${ext || 'png'}`;
  return { mimeType: mime, data: image.data.toString('base64') };
}

function result(
  def: MediaProviderDef,
  model: string,
  outPath: string,
  startedAt: number,
  deps: MediaDeps,
  costParams: { chars?: number; seconds?: number } = {},
): MediaGenerationResult {
  return {
    ok: true,
    path: outPath,
    provider: def.id,
    model,
    kind: def.kind,
    estimatedCostUsd: def.estimateCost({ model, ...costParams }),
    durationMs: deps.now() - startedAt,
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
  const parts: unknown[] = [{ text: req.prompt }];
  if (image) parts.push({ inlineData: fileToInlineData(image) });
  const res = await deps.fetchFn(`${GEMINI_BASE}/models/${model}:generateContent`, {
    method: 'POST',
    headers: { 'x-goog-api-key': key, 'content-type': 'application/json' },
    body: JSON.stringify({
      contents: [{ role: 'user', parts }],
      generationConfig: { responseModalities: ['TEXT', 'IMAGE'] },
    }),
  });
  if (!res.ok) throw await httpError(res, def.id);
  const json = (await res.json()) as {
    candidates?: Array<{
      content?: { parts?: Array<{ text?: string; inlineData?: { data?: string } }> };
    }>;
  };
  const partsOut = json.candidates?.[0]?.content?.parts ?? [];
  const inline = partsOut.find((p) => p.inlineData?.data)?.inlineData;
  if (!inline?.data) {
    const text = partsOut.map((p) => p.text ?? '').join(' ').trim().slice(0, 200);
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
  let res: Response;
  if (image) {
    const form = new FormData();
    form.set('model', model);
    form.set('prompt', req.prompt);
    form.set(
      'image',
      new Blob([new Uint8Array(image.data)]),
      path.basename(image.path),
    );
    res = await deps.fetchFn(`${OPENAI_BASE}/images/edits`, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}` },
      body: form,
    });
  } else {
    res = await deps.fetchFn(`${OPENAI_BASE}/images/generations`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${key}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ model, prompt: req.prompt, n: 1 }),
    });
  }
  if (!res.ok) throw await httpError(res, def.id);
  const json = (await res.json()) as {
    data?: Array<{ b64_json?: string; url?: string }>;
  };
  const first = json.data?.[0];
  if (first?.b64_json) return Buffer.from(first.b64_json, 'base64');
  if (first?.url) {
    return downloadProviderAsset(first.url, 'openai-image', {
      fetchFn: deps.fetchFn,
      resolveHostname: deps.resolveHostname,
      fetchPinned: deps.fetchPinned,
    });
  }
  throw new Error(`${def.id}: resposta sem imagem`);
}

export async function generateImage(
  req: ImageRequest,
  deps: MediaDeps = defaultMediaDeps(),
): Promise<MediaGenerationResult> {
  const startedAt = deps.now();
  const def = resolveMediaProvider('image', req.provider, (d) =>
    Boolean(deps.getKey(d)),
  );
  const model = resolveMediaModel(def, req.model);
  const key = requireKey(def, deps);
  const outPath = resolveOutPath(req.outPath, req.baseDir, 'png', deps.now);
  const image = req.imagePath
    ? readMediaInput(req.imagePath, req.baseDir)
    : undefined;
  const data =
    def.id === 'google-image'
      ? await googleImage(req, def, model, key, deps, image)
      : await openaiImage(req, def, model, key, deps, image);
  writeMediaOutput(outPath, req.baseDir, data);
  return result(def, model, outPath, startedAt, deps);
}

// ── Video ────────────────────────────────────────────────────────────────────

/**
 * Image-to-video input FIELD NAME differs by Replicate model family. Passing
 * the wrong one drops the first frame silently. Verified against live OpenAPI
 * schemas (2026-07) and the Overclock mediaGeneration adapter.
 */
export function replicateImageField(model: string): string {
  if (model.startsWith('kwaivgi/kling')) return 'start_image';
  if (model.startsWith('minimax/hailuo') || model.startsWith('minimax/video-01')) {
    return 'first_frame_image';
  }
  // seedance, veo, wan-video, default
  return 'image';
}

/** End / last-frame field when the family supports keyframe interpolation. */
export function replicateEndImageField(model: string): string | null {
  if (model.startsWith('kwaivgi/kling')) return 'end_image';
  if (model.startsWith('bytedance/seedance')) return 'last_frame_image';
  if (model.startsWith('google/veo')) return 'last_frame';
  return null;
}

function dataUri(image: MediaInputFile): string {
  const ext = path.extname(image.path).toLowerCase().replace('.', '');
  const mime =
    ext === 'jpg' || ext === 'jpeg'
      ? 'image/jpeg'
      : ext === 'webp'
        ? 'image/webp'
        : 'image/png';
  return `data:${mime};base64,${image.data.toString('base64')}`;
}

/**
 * Build the Replicate prediction `input` for the requested model. Seedance /
 * Veo get duration/resolution/aspect/audio knobs; Kling/Hailuo only get the
 * fields their OpenAPI accepts (avoid enum mismatches on foreign params).
 */
export function replicateInput(
  req: VideoRequest,
  model: string,
  image?: MediaInputFile,
  endImage?: MediaInputFile,
): Record<string, unknown> {
  const isSeedance = model.startsWith('bytedance/seedance');
  const isVeo = model.startsWith('google/veo');
  const isKling = model.startsWith('kwaivgi/kling');
  const isHailuo = model.startsWith('minimax/hailuo');

  const input: Record<string, unknown> = { prompt: req.prompt };

  if (isSeedance || isVeo) {
    input.duration = req.durationSeconds ?? 5;
    input.resolution = req.resolution ?? '720p';
    input.aspect_ratio = req.aspectRatio ?? '16:9';
    // Lite has no generate_audio in its schema; skip it there.
    if (!(isVeo && model.endsWith('-lite'))) {
      input.generate_audio = true;
    }
  } else if (isKling) {
    // Kling v3 accepts duration + aspect_ratio + generate_audio; mode maps
    // resolution (standard/pro/4k) — only set duration/aspect when provided.
    if (req.durationSeconds !== undefined) input.duration = req.durationSeconds;
    if (req.aspectRatio) input.aspect_ratio = req.aspectRatio;
    if (req.resolution === '720p') input.mode = 'standard';
    else if (req.resolution === '1080p') input.mode = 'pro';
    else if (req.resolution === '4k') input.mode = '4k';
  } else if (isHailuo) {
    if (req.durationSeconds !== undefined) input.duration = req.durationSeconds;
    if (req.resolution) input.resolution = req.resolution;
  }

  if (image) {
    input[replicateImageField(model)] = dataUri(image);
  }
  if (endImage) {
    const endField = replicateEndImageField(model);
    if (endField) input[endField] = dataUri(endImage);
  }
  return input;
}

export async function generateVideo(
  req: VideoRequest,
  deps: MediaDeps = defaultMediaDeps(),
): Promise<MediaGenerationResult> {
  const startedAt = deps.now();
  const def = resolveMediaProvider('video', req.provider, (d) =>
    Boolean(deps.getKey(d)),
  );
  const model = resolveMediaModel(def, req.model);
  const key = requireKey(def, deps);
  const outPath = resolveOutPath(req.outPath, req.baseDir, 'mp4', deps.now);
  const image = req.imagePath
    ? readMediaInput(req.imagePath, req.baseDir)
    : undefined;
  const endImage = req.endImagePath
    ? readMediaInput(req.endImagePath, req.baseDir)
    : undefined;

  const create = await deps.fetchFn(
    `${REPLICATE_BASE}/models/${model}/predictions`,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${key}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        input: replicateInput(req, model, image, endImage),
      }),
    },
  );
  if (!create.ok) throw await httpError(create, def.id);
  let prediction = (await create.json()) as {
    id?: string;
    status?: string;
    output?: string | string[];
    error?: string;
  };
  if (!prediction.id) throw new Error(`${def.id}: prediction sem id`);

  for (
    let poll = 0;
    prediction.status !== 'succeeded' && poll < REPLICATE_MAX_POLLS;
    poll += 1
  ) {
    if (prediction.status === 'failed' || prediction.status === 'canceled') {
      throw new Error(
        `${def.id}: prediction ${prediction.status} — ${prediction.error ?? 'sem causa'}`,
      );
    }
    await deps.sleep(REPLICATE_POLL_MS);
    const res = await deps.fetchFn(
      `${REPLICATE_BASE}/predictions/${prediction.id}`,
      { headers: { authorization: `Bearer ${key}` } },
    );
    if (!res.ok) throw await httpError(res, def.id);
    prediction = (await res.json()) as typeof prediction;
  }
  if (prediction.status !== 'succeeded') {
    throw new Error(`${def.id}: timeout esperando a prediction ${prediction.id}`);
  }
  const url = Array.isArray(prediction.output)
    ? prediction.output[0]
    : prediction.output;
  if (!url) throw new Error(`${def.id}: prediction sem output`);
  const data = await downloadProviderAsset(url, 'replicate-video', {
    fetchFn: deps.fetchFn,
    resolveHostname: deps.resolveHostname,
    fetchPinned: deps.fetchPinned,
  });
  writeMediaOutput(outPath, req.baseDir, data);
  return result(def, model, outPath, startedAt, deps, {
    seconds: req.durationSeconds ?? 5,
  });
}

// ── Audio ────────────────────────────────────────────────────────────────────

export async function generateAudio(
  req: AudioRequest,
  deps: MediaDeps = defaultMediaDeps(),
): Promise<MediaGenerationResult> {
  const startedAt = deps.now();
  const def = resolveMediaProvider('audio', req.provider, (d) =>
    Boolean(deps.getKey(d)),
  );
  const model = resolveMediaModel(def, req.model);
  const key = requireKey(def, deps);
  const voiceId = req.voiceId ?? DEFAULT_ELEVENLABS_VOICE;
  const outPath = resolveOutPath(req.outPath, req.baseDir, 'mp3', deps.now);

  const res = await deps.fetchFn(
    `${ELEVENLABS_BASE}/text-to-speech/${encodeURIComponent(voiceId)}`,
    {
      method: 'POST',
      headers: { 'xi-api-key': key, 'content-type': 'application/json' },
      body: JSON.stringify({ text: req.text, model_id: model }),
    },
  );
  if (!res.ok) throw await httpError(res, def.id);

  writeMediaOutput(outPath, req.baseDir, Buffer.from(await res.arrayBuffer()));
  return result(def, model, outPath, startedAt, deps, {
    chars: req.text.length,
  });
}

// ── Default deps (electron edge) ─────────────────────────────────────────────

function defaultMediaDeps(): MediaDeps {
  // Lazy require keeps this module importable from unit tests (no electron).
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { resolveMediaKey } = require('./media-keys') as typeof import('./media-keys');
  const { resolveBrowserHostname } = require('../browser/url-policy') as typeof import('../browser/url-policy');
  return {
    fetchFn: fetch,
    resolveHostname: resolveBrowserHostname,
    fetchPinned: fetchPinnedProviderAsset,
    getKey: (def) => resolveMediaKey(def),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: Date.now,
  };
}
