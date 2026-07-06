import fs from 'node:fs';
import path from 'node:path';
import type { MediaGenerationResult } from '../../shared/media-types';
import {
  resolveMediaModel,
  resolveMediaProvider,
  resolveOutPath,
  type MediaProviderDef,
} from './media-providers';

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

function writeOut(outPath: string, data: Buffer): void {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, data);
}

function fileToInlineData(imagePath: string): { mimeType: string; data: string } {
  const ext = path.extname(imagePath).toLowerCase().replace('.', '');
  const mime = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : `image/${ext || 'png'}`;
  return { mimeType: mime, data: fs.readFileSync(imagePath).toString('base64') };
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
): Promise<Buffer> {
  const parts: unknown[] = [{ text: req.prompt }];
  if (req.imagePath) parts.push({ inlineData: fileToInlineData(req.imagePath) });
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
): Promise<Buffer> {
  let res: Response;
  if (req.imagePath) {
    const form = new FormData();
    form.set('model', model);
    form.set('prompt', req.prompt);
    form.set(
      'image',
      new Blob([new Uint8Array(fs.readFileSync(req.imagePath))]),
      path.basename(req.imagePath),
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
    const bin = await deps.fetchFn(first.url);
    if (!bin.ok) throw await httpError(bin, def.id);
    return Buffer.from(await bin.arrayBuffer());
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
  const data =
    def.id === 'google-image'
      ? await googleImage(req, def, model, key, deps)
      : await openaiImage(req, def, model, key, deps);
  const outPath = resolveOutPath(req.outPath, req.baseDir, 'png', deps.now);
  writeOut(outPath, data);
  return result(def, model, outPath, startedAt, deps);
}

// ── Video ────────────────────────────────────────────────────────────────────

function replicateInput(req: VideoRequest, model: string): Record<string, unknown> {
  const input: Record<string, unknown> = { prompt: req.prompt };
  if (model.includes('seedance')) {
    input.resolution = req.resolution ?? '720p';
    input.duration = req.durationSeconds ?? 5;
    input.aspect_ratio = req.aspectRatio ?? '16:9';
    input.generate_audio = true;
  }
  if (req.imagePath) {
    input.image = `data:image/png;base64,${fs.readFileSync(req.imagePath).toString('base64')}`;
  }
  if (req.endImagePath && model.includes('kling')) {
    input.end_image = `data:image/png;base64,${fs.readFileSync(req.endImagePath).toString('base64')}`;
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

  const create = await deps.fetchFn(
    `${REPLICATE_BASE}/models/${model}/predictions`,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${key}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ input: replicateInput(req, model) }),
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
  const bin = await deps.fetchFn(url);
  if (!bin.ok) throw await httpError(bin, def.id);

  const outPath = resolveOutPath(req.outPath, req.baseDir, 'mp4', deps.now);
  writeOut(outPath, Buffer.from(await bin.arrayBuffer()));
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

  const res = await deps.fetchFn(
    `${ELEVENLABS_BASE}/text-to-speech/${encodeURIComponent(voiceId)}`,
    {
      method: 'POST',
      headers: { 'xi-api-key': key, 'content-type': 'application/json' },
      body: JSON.stringify({ text: req.text, model_id: model }),
    },
  );
  if (!res.ok) throw await httpError(res, def.id);

  const outPath = resolveOutPath(req.outPath, req.baseDir, 'mp3', deps.now);
  writeOut(outPath, Buffer.from(await res.arrayBuffer()));
  return result(def, model, outPath, startedAt, deps, {
    chars: req.text.length,
  });
}

// ── Default deps (electron edge) ─────────────────────────────────────────────

function defaultMediaDeps(): MediaDeps {
  // Lazy require keeps this module importable from unit tests (no electron).
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { resolveMediaKey } = require('./media-keys') as typeof import('./media-keys');
  return {
    fetchFn: fetch,
    getKey: (def) => resolveMediaKey(def),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: Date.now,
  };
}
