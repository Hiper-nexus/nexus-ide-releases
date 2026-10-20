import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { MediaGenerationResult } from '../../shared/media-types';
import {
  higgsfieldImageModel,
  higgsfieldVideoModel,
  type HiggsfieldVideoModel,
} from '../../shared/higgsfield-models';
import { videoModelSpec } from '../../shared/media-video-models';
import { downloadProviderAsset } from './media-download';
import { mediaHttpError } from './media-errors';
import type { ImageRequest, VideoRequest } from './media-generation';
import { readMediaInput, writeMediaOutput, type MediaInputFile } from './media-path-policy';
import { resolveOutPath, type MediaProviderDef } from './media-providers';
import {
  assertMediaAuthorityCurrent,
  MediaJobTimeoutError,
  mediaResult as result,
  sleepWhileAuthorized,
  type MediaAuthorityRequest,
  type MediaDeps,
} from './media-runtime';
import {
  getVideoJob,
  jobBilling,
  MediaJobGoneError,
  savedJobBilling,
  saveVideoJob,
  settleVideoJob,
  type MediaVideoJobRecord,
} from './media-video-jobs';

/**
 * Higgsfield (F-1613) — `api.higgsfield.ai`, contrato de
 * `docs.higgsfield.ai/docs` lido em 20/10/2026:
 *
 * - Autenticação `Authorization: Key {id}:{segredo}` (nunca Bearer).
 * - `POST /{endpoint}` com `Idempotency-Key` → `{request_id, status_url}`;
 *   `GET /requests/{id}/status` até `completed` (`images[].url` /
 *   `video.url`), `failed`, `nsfw` ou `canceled` — esses três não cobram.
 * - Entradas só por URL: o arquivo do projeto sobe por URL pré-assinada
 *   (`POST /files/generate-upload-url` → `PUT` com os `upload_headers`, SEM a
 *   chave da Higgsfield).
 * - Preço por pedido em `POST /estimate/{endpoint}` (mesmo corpo): é o custo
 *   autoritativo; falha na cotação não impede gerar.
 *
 * A URL de status é sempre montada aqui a partir de um `request_id` UUID — o
 * arquivo de jobs mora no projeto e não é confiável; a chave nunca vai para
 * uma URL que veio dele.
 */

export const HIGGSFIELD_BASE = 'https://api.higgsfield.ai';

const POLL_MS = 4_000;
const IMAGE_MAX_POLLS = 60; // 4 min
const VIDEO_MAX_POLLS = 150; // 10 min
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

const UPLOAD_MIME: Readonly<Record<string, string>> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.mp4': 'video/mp4',
  '.wav': 'audio/wav',
};

/** `ID:SEGREDO` (com ou sem o prefixo `Key `) → valor do cabeçalho. */
export function higgsfieldAuthHeader(key: string): string {
  const raw = key.trim().replace(/^key\s+/iu, '');
  if (!/^[^:\s]+:\S+$/u.test(raw)) {
    throw new Error(
      'A chave da Higgsfield tem duas partes: cole no formato ID:SEGREDO em Ajustes → Serviços de mídia.',
    );
  }
  return `Key ${raw}`;
}

export function higgsfieldRequestId(json: unknown): string {
  const id = (json as { request_id?: unknown } | null)?.request_id;
  if (typeof id !== 'string' || !UUID.test(id)) {
    throw new Error('Higgsfield: resposta sem request_id válido');
  }
  return id;
}

export function higgsfieldStatusUrl(requestId: string): string {
  if (!UUID.test(requestId)) throw new Error('Higgsfield: request_id inválido');
  return `${HIGGSFIELD_BASE}/requests/${requestId}/status`;
}

export type HiggsfieldPoll =
  | { readonly state: 'pending' }
  | { readonly state: 'done'; readonly url: string }
  | { readonly state: 'failed'; readonly problem: string };

export function readHiggsfieldStatus(json: unknown, kind: 'image' | 'video'): HiggsfieldPoll {
  const body = (json ?? {}) as {
    status?: unknown;
    error?: unknown;
    video?: { url?: unknown };
    images?: Array<{ url?: unknown }>;
  };
  const error = typeof body.error === 'string' && body.error.trim() ? ` (${body.error.trim()})` : '';
  switch (body.status) {
    case 'queued':
    case 'in_progress':
      return { state: 'pending' };
    case 'completed': {
      const url = kind === 'video' ? body.video?.url : body.images?.[0]?.url;
      return typeof url === 'string' && url
        ? { state: 'done', url }
        : { state: 'failed', problem: 'A Higgsfield concluiu o pedido sem arquivo de saída.' };
    }
    case 'nsfw':
      return {
        state: 'failed',
        problem:
          'A Higgsfield bloqueou o resultado pela moderação; o pedido não é cobrado. Ajuste o texto ou as imagens.',
      };
    case 'failed':
      return {
        state: 'failed',
        problem: `A Higgsfield não conseguiu gerar${error}; o pedido não é cobrado. Tente de novo ou troque o modelo.`,
      };
    case 'canceled':
      return { state: 'failed', problem: 'O pedido foi cancelado na Higgsfield.' };
    default:
      return {
        state: 'failed',
        problem: `A Higgsfield respondeu um estado desconhecido (${String(body.status)}).`,
      };
  }
}

export type HiggsfieldVideoFlow = 'text' | 'image' | 'reference';

export interface HiggsfieldVideoInputs {
  readonly hasImage: boolean;
  readonly hasEndImage: boolean;
  readonly referenceImages: number;
  readonly referenceVideos: number;
}

/** Fluxo e endpoint pelo que o pedido leva; frase em pt-BR quando não dá. */
export function higgsfieldVideoPlan(
  model: string,
  inputs: HiggsfieldVideoInputs,
): { flow: HiggsfieldVideoFlow; endpoint: string; def: HiggsfieldVideoModel } {
  const def = higgsfieldVideoModel(model);
  if (!def) throw new Error(`modelo ${model} não é da Higgsfield`);
  const refs = inputs.referenceImages + inputs.referenceVideos;
  if (refs > 0) {
    if (!def.referenceToVideo) {
      throw new Error(`${def.label} na Higgsfield não recebe referências: use só a imagem inicial.`);
    }
    if (inputs.hasImage || inputs.hasEndImage) {
      throw new Error(
        `${def.label} na Higgsfield não combina primeiro quadro com referências: use um ou outro.`,
      );
    }
    return { flow: 'reference', endpoint: def.referenceToVideo, def };
  }
  if (inputs.hasImage) {
    if (!def.imageToVideo) throw new Error(`${def.label} na Higgsfield não gera a partir de imagem.`);
    return { flow: 'image', endpoint: def.imageToVideo, def };
  }
  if (inputs.hasEndImage) {
    throw new Error('O último quadro precisa do primeiro quadro (imagePath).');
  }
  return { flow: 'text', endpoint: def.textToVideo, def };
}

export interface HiggsfieldVideoUrls {
  readonly image?: string;
  readonly endImage?: string;
  readonly images: readonly string[];
  readonly videos: readonly string[];
}

export function higgsfieldVideoBody(
  model: string,
  flow: HiggsfieldVideoFlow,
  req: Pick<VideoRequest, 'prompt' | 'durationSeconds' | 'resolution' | 'aspectRatio'>,
  urls: HiggsfieldVideoUrls,
): Record<string, unknown> {
  const def = higgsfieldVideoModel(model);
  if (!def) throw new Error(`modelo ${model} não é da Higgsfield`);
  const spec = videoModelSpec(model);
  const body: Record<string, unknown> = { ...(def.fixed ?? {}) };
  if (req.prompt?.trim()) body.prompt = req.prompt.trim();
  const duration = req.durationSeconds ?? spec?.defaultDuration;
  if (duration !== undefined) body.duration = duration;
  if (spec && spec.resolutions.length > 0) {
    body.resolution = req.resolution ?? spec.defaultResolution;
  }
  const aspect = req.aspectRatio;
  if (aspect && (flow !== 'image' || def.aspectInImageToVideo)) body.aspect_ratio = aspect;
  if (flow === 'image') {
    body.image_url = urls.image;
    if (urls.endImage && def.endImageField) body[def.endImageField] = urls.endImage;
  }
  if (flow === 'reference') {
    if (urls.images.length > 0) body.image_urls = [...urls.images];
    if (urls.videos.length > 0) body.video_urls = [...urls.videos];
  }
  return body;
}

export function higgsfieldImagePlan(
  model: string,
  inputCount: number,
): { endpoint: string; field?: 'image_url' | 'image_urls' } {
  const def = higgsfieldImageModel(model);
  if (!def) throw new Error(`modelo ${model} não é da Higgsfield`);
  if (inputCount === 0) return { endpoint: def.textToImage };
  if (!def.edit || !def.editField || def.maxInputImages === 0) {
    throw new Error(`${def.label} gera só a partir do texto: tire as imagens do pedido.`);
  }
  if (inputCount > def.maxInputImages) {
    throw new Error(`${def.label} aceita até ${def.maxInputImages} imagem(ns) de entrada (pedido: ${inputCount}).`);
  }
  return { endpoint: def.edit, field: def.editField };
}

export function higgsfieldImageBody(
  model: string,
  req: Pick<ImageRequest, 'prompt' | 'aspectRatio'>,
  field: 'image_url' | 'image_urls' | undefined,
  urls: readonly string[],
): Record<string, unknown> {
  const def = higgsfieldImageModel(model);
  if (!def) throw new Error(`modelo ${model} não é da Higgsfield`);
  const body: Record<string, unknown> = { ...(def.fixed ?? {}), prompt: req.prompt };
  if (req.aspectRatio) {
    if (!def.aspectRatios.includes(req.aspectRatio)) {
      throw new Error(
        `${def.label} aceita proporção ${def.aspectRatios.join(', ')} (pedido: ${req.aspectRatio}).`,
      );
    }
    body.aspect_ratio = req.aspectRatio;
  }
  if (field === 'image_url') body.image_url = urls[0];
  if (field === 'image_urls') body.image_urls = [...urls];
  return body;
}

function httpsUrl(raw: unknown, what: string): string {
  if (typeof raw !== 'string') throw new Error(`Higgsfield: ${what} ausente`);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`Higgsfield: ${what} inválida`);
  }
  if (url.protocol !== 'https:' || url.username || url.password) {
    throw new Error(`Higgsfield: ${what} precisa ser HTTPS sem credenciais`);
  }
  return url.toString();
}

interface HfContext {
  readonly def: MediaProviderDef;
  readonly auth: string;
  readonly deps: MediaDeps;
  readonly req: MediaAuthorityRequest;
}

/** Sobe um arquivo do projeto e devolve a URL pública que o modelo lê. */
export async function uploadHiggsfieldInput(file: MediaInputFile, ctx: HfContext): Promise<string> {
  const contentType = UPLOAD_MIME[path.extname(file.path).toLowerCase()];
  if (!contentType) {
    throw new Error(
      `A Higgsfield não aceita ${path.extname(file.path) || 'este arquivo'} como entrada: use PNG, JPG, WEBP, GIF ou MP4.`,
    );
  }
  assertMediaAuthorityCurrent(ctx.req);
  const res = await ctx.deps.fetchFn(`${HIGGSFIELD_BASE}/files/generate-upload-url`, {
    method: 'POST',
    headers: { authorization: ctx.auth, 'content-type': 'application/json' },
    body: JSON.stringify({ content_type: contentType }),
    signal: ctx.req.signal,
  });
  assertMediaAuthorityCurrent(ctx.req);
  if (!res.ok) throw await mediaHttpError(res, ctx.def.id);
  const json = (await res.json()) as {
    public_url?: unknown;
    upload_url?: unknown;
    upload_headers?: Record<string, unknown>;
  };
  const uploadUrl = httpsUrl(json.upload_url, 'URL de upload');
  const publicUrl = httpsUrl(json.public_url, 'URL pública do upload');
  // Só os cabeçalhos que a Higgsfield mandou; nunca a chave dela.
  const headers: Record<string, string> = { 'content-type': contentType };
  for (const [name, value] of Object.entries(json.upload_headers ?? {})) {
    if (typeof value === 'string' && name.toLowerCase() !== 'authorization') {
      headers[name.toLowerCase()] = value;
    }
  }
  const put = await ctx.deps.fetchFn(uploadUrl, {
    method: 'PUT',
    headers,
    body: new Uint8Array(file.data),
    signal: ctx.req.signal,
  });
  assertMediaAuthorityCurrent(ctx.req);
  if (!put.ok) throw await mediaHttpError(put, ctx.def.id);
  return publicUrl;
}

/** USD que a Higgsfield cobra por este pedido; `null` se a cotação falhar. */
export async function quoteHiggsfield(
  endpoint: string,
  body: Record<string, unknown>,
  ctx: HfContext,
): Promise<number | null> {
  try {
    const res = await ctx.deps.fetchFn(`${HIGGSFIELD_BASE}/estimate/${endpoint}`, {
      method: 'POST',
      headers: { authorization: ctx.auth, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctx.req.signal,
    });
    if (!res.ok) return null;
    const usd = Number((await res.json() as { usd?: unknown }).usd);
    return Number.isFinite(usd) && usd >= 0 ? Number(usd.toFixed(4)) : null;
  } catch (error) {
    if (ctx.req.signal?.aborted) throw error;
    return null;
  } finally {
    assertMediaAuthorityCurrent(ctx.req);
  }
}

async function submitHiggsfield(
  endpoint: string,
  body: Record<string, unknown>,
  ctx: HfContext,
): Promise<string> {
  assertMediaAuthorityCurrent(ctx.req);
  const res = await ctx.deps.fetchFn(`${HIGGSFIELD_BASE}/${endpoint}`, {
    method: 'POST',
    headers: {
      authorization: ctx.auth,
      'content-type': 'application/json',
      // Reenvio do mesmo pedido não cobra duas vezes.
      'idempotency-key': randomUUID(),
    },
    body: JSON.stringify(body),
    signal: ctx.req.signal,
  });
  assertMediaAuthorityCurrent(ctx.req);
  if (!res.ok) throw await mediaHttpError(res, ctx.def.id);
  return higgsfieldRequestId(await res.json());
}

async function pollHiggsfield(
  requestId: string,
  kind: 'image' | 'video',
  maxPolls: number,
  ctx: HfContext,
): Promise<string> {
  let poll: HiggsfieldPoll = { state: 'pending' };
  for (let attempt = 0; poll.state === 'pending'; attempt += 1) {
    if (attempt >= maxPolls) throw new MediaJobTimeoutError(ctx.def.id, requestId);
    await sleepWhileAuthorized(ctx.deps, POLL_MS, ctx.req);
    const res = await ctx.deps.fetchFn(higgsfieldStatusUrl(requestId), {
      headers: { authorization: ctx.auth },
      signal: ctx.req.signal,
    });
    assertMediaAuthorityCurrent(ctx.req);
    if (res.status === 404) {
      throw new MediaJobGoneError('A Higgsfield não conhece mais este pedido (HTTP 404); gere de novo.');
    }
    // 5xx no status é passageiro: o próximo ciclo tenta de novo.
    if (res.status >= 500) continue;
    if (!res.ok) throw await mediaHttpError(res, ctx.def.id);
    poll = readHiggsfieldStatus(await res.json(), kind);
  }
  if (poll.state === 'failed') throw new MediaJobGoneError(poll.problem);
  return poll.url;
}

/** Extensão pelo começo do arquivo (a Higgsfield devolve JPG, PNG ou WEBP). */
function imageExtension(data: Buffer): string {
  if (data.length >= 4 && data[0] === 0x89 && data.toString('latin1', 1, 4) === 'PNG') return 'png';
  if (data.length >= 12 && data.toString('latin1', 8, 12) === 'WEBP') return 'webp';
  return 'jpg';
}

export async function generateImageHiggsfield(
  req: ImageRequest,
  def: MediaProviderDef,
  model: string,
  key: string,
  deps: MediaDeps,
  inputs: readonly MediaInputFile[],
): Promise<{ data: Buffer; extension: string; costUsd: number | null }> {
  const ctx: HfContext = { def, auth: higgsfieldAuthHeader(key), deps, req };
  const plan = higgsfieldImagePlan(model, inputs.length);
  const urls: string[] = [];
  for (const file of inputs) urls.push(await uploadHiggsfieldInput(file, ctx));
  const body = higgsfieldImageBody(model, req, plan.field, urls);
  const costUsd = await quoteHiggsfield(plan.endpoint, body, ctx);
  const requestId = await submitHiggsfield(plan.endpoint, body, ctx);
  const url = await pollHiggsfield(requestId, 'image', IMAGE_MAX_POLLS, ctx);
  const data = await downloadProviderAsset(
    url,
    'higgsfield-image',
    { fetchFn: deps.fetchFn, resolveHostname: deps.resolveHostname, fetchPinned: deps.fetchPinned },
    undefined,
    req.signal,
  );
  assertMediaAuthorityCurrent(req);
  return { data, extension: imageExtension(data), costUsd };
}

async function finishHiggsfieldVideo(
  job: MediaVideoJobRecord,
  outPath: string,
  req: VideoRequest,
  ctx: HfContext,
  startedAt: number,
): Promise<MediaGenerationResult> {
  return settleVideoJob(job, req, async () => {
    const url = await pollHiggsfield(job.pollTarget, 'video', VIDEO_MAX_POLLS, ctx);
    const data = await downloadProviderAsset(
      url,
      'higgsfield-video',
      { fetchFn: ctx.deps.fetchFn, resolveHostname: ctx.deps.resolveHostname, fetchPinned: ctx.deps.fetchPinned },
      undefined,
      req.signal,
    );
    assertMediaAuthorityCurrent(req);
    writeMediaOutput(outPath, req.baseDir, data);
    assertMediaAuthorityCurrent(req);
    saveVideoJob(req.baseDir, { ...job, status: 'completed' });
    const billing = savedJobBilling(job);
    const done = result(
      ctx.def,
      job.model,
      outPath,
      startedAt,
      ctx.deps,
      { seconds: billing.seconds ?? req.durationSeconds, resolution: billing.resolution ?? req.resolution },
      job.jobId,
    );
    const quoted = typeof job.quotedCostUsd === 'number' && job.quotedCostUsd >= 0 ? job.quotedCostUsd : null;
    return { ...done, estimatedCostUsd: quoted };
  });
}

export async function generateVideoHiggsfield(
  req: VideoRequest,
  def: MediaProviderDef,
  model: string,
  key: string,
  deps: MediaDeps,
  startedAt: number,
): Promise<MediaGenerationResult> {
  const ctx: HfContext = { def, auth: higgsfieldAuthHeader(key), deps, req };
  if (req.recoverJobId) {
    assertMediaAuthorityCurrent(req);
    const saved = getVideoJob(req.baseDir, req.recoverJobId);
    if (!saved || saved.provider !== 'higgsfield-video') {
      throw new Error(`job '${req.recoverJobId}' não encontrado em .nexus/media/video-jobs.json`);
    }
    const dest = resolveOutPath(req.outPath ?? saved.outPath, req.baseDir, 'mp4', deps.now);
    return finishHiggsfieldVideo(saved, dest, req, ctx, startedAt);
  }

  const outPath = resolveOutPath(req.outPath, req.baseDir, 'mp4', deps.now);
  const refImages = req.referenceImagePaths ?? [];
  const refVideos = req.referenceVideoPaths ?? [];
  const plan = higgsfieldVideoPlan(model, {
    hasImage: Boolean(req.imagePath),
    hasEndImage: Boolean(req.endImagePath),
    referenceImages: refImages.length,
    referenceVideos: refVideos.length,
  });
  if (refImages.length > plan.def.maxReferenceImages) {
    throw new Error(`${plan.def.label} aceita até ${plan.def.maxReferenceImages} imagens de referência.`);
  }
  if (refVideos.length > plan.def.maxReferenceVideos) {
    throw new Error(`${plan.def.label} aceita até ${plan.def.maxReferenceVideos} vídeos de exemplo.`);
  }
  const upload = (file: string) => uploadHiggsfieldInput(readMediaInput(file, req.baseDir), ctx);
  const urls: HiggsfieldVideoUrls = {
    image: req.imagePath ? await upload(req.imagePath) : undefined,
    endImage: req.endImagePath ? await upload(req.endImagePath) : undefined,
    images: await Promise.all(refImages.map(upload)),
    videos: await Promise.all(refVideos.map(upload)),
  };
  const body = higgsfieldVideoBody(model, plan.flow, req, urls);
  const quotedCostUsd = await quoteHiggsfield(plan.endpoint, body, ctx);
  const requestId = await submitHiggsfield(plan.endpoint, body, ctx);
  const job: MediaVideoJobRecord = {
    jobId: requestId,
    provider: 'higgsfield-video',
    pollTarget: requestId,
    model,
    prompt: req.prompt,
    outPath: req.outPath,
    startedAt: deps.now(),
    status: 'pending',
    ...jobBilling(req),
    ...(quotedCostUsd !== null ? { quotedCostUsd } : {}),
  };
  // Aceito e cobrável: a identidade de retomada fica salva antes de esperar.
  saveVideoJob(req.baseDir, job);
  assertMediaAuthorityCurrent(req);
  return finishHiggsfieldVideo(job, outPath, req, ctx, startedAt);
}
