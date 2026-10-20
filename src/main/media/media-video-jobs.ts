import fs from 'node:fs';
import path from 'node:path';
import { videoModelSpec, type GeminiOmniUsage } from '../../shared/media-video-models';
import {
  assertMediaAuthorityCurrent,
  MediaJobInterruptedError,
  MediaJobTimeoutError,
  type MediaAuthorityRequest,
} from './media-runtime';

/**
 * Persist long-running video predictions so a timed-out call can resume
 * without paying twice (ADE parity: recoverJobId).
 *
 * Jobs live under the open workspace: `.nexus/media/video-jobs.json`.
 */

export type MediaVideoJobProvider =
  | 'replicate-video'
  | 'google-video'
  | 'xai-video'
  | 'higgsfield-video';

export interface MediaVideoJobRecord {
  jobId: string;
  provider: MediaVideoJobProvider;
  /**
   * Absolute poll URL (Replicate), operation resource name or Files API id
   * (Google), or the xAI `request_id`.
   */
  pollTarget: string;
  model: string;
  prompt: string;
  outPath?: string;
  startedAt: number;
  status: 'pending' | 'completed' | 'failed';
  /**
   * F-1587: o que foi gerado, para a retomada cobrar certo (quem retoma só com
   * `recoverJobId` não manda resolução nem duração). O arquivo é do
   * workspace: o motor confere antes de usar.
   */
  resolution?: string;
  durationSeconds?: number;
  /** Imagens de entrada do pedido (cobradas à parte no Grok Imagine). */
  inputImages?: number;
  /** Tokens que o Google cobrou (Gemini Omni). */
  usage?: GeminiOmniUsage;
  /** F-1613: USD que a Higgsfield cotou para o pedido (`/estimate`). */
  quotedCostUsd?: number;
}

const JOBS_REL = path.join('.nexus', 'media', 'video-jobs.json');
const MAX_JOBS = 50;

function jobsPath(baseDir: string): string {
  return path.join(baseDir, JOBS_REL);
}

export function loadVideoJobs(baseDir: string): Record<string, MediaVideoJobRecord> {
  try {
    const file = jobsPath(baseDir);
    if (!fs.existsSync(file)) return {};
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
    return raw as Record<string, MediaVideoJobRecord>;
  } catch {
    return {};
  }
}

export function saveVideoJob(baseDir: string, record: MediaVideoJobRecord): void {
  const file = jobsPath(baseDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const jobs = loadVideoJobs(baseDir);
  jobs[record.jobId] = record;
  // Keep the newest MAX_JOBS entries to avoid unbounded growth.
  const entries = Object.values(jobs).sort((a, b) => b.startedAt - a.startedAt);
  const trimmed: Record<string, MediaVideoJobRecord> = {};
  for (const job of entries.slice(0, MAX_JOBS)) {
    trimmed[job.jobId] = job;
  }
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(trimmed, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

export function getVideoJob(
  baseDir: string,
  jobId: string,
): MediaVideoJobRecord | null {
  const jobs = loadVideoJobs(baseDir);
  return jobs[jobId] ?? null;
}

/** Resolução e duração do pedido, guardadas no job para a retomada (F-1587). */
export function jobBilling(req: {
  resolution?: string;
  durationSeconds?: number;
  imagePath?: string;
  endImagePath?: string;
  referenceImagePaths?: string[];
}): Pick<MediaVideoJobRecord, 'resolution' | 'durationSeconds' | 'inputImages'> {
  const inputImages = videoInputImageCount(req);
  return {
    ...(req.resolution ? { resolution: req.resolution } : {}),
    ...(req.durationSeconds !== undefined ? { durationSeconds: req.durationSeconds } : {}),
    ...(inputImages > 0 ? { inputImages } : {}),
  };
}

/** Imagens que o pedido manda ao serviço: inicial, final e referências. */
export function videoInputImageCount(req: {
  imagePath?: string;
  endImagePath?: string;
  referenceImagePaths?: string[];
}): number {
  return (req.imagePath ? 1 : 0) + (req.endImagePath ? 1 : 0) + (req.referenceImagePaths?.length ?? 0);
}

/**
 * Resolução e duração salvas no job, só quando o modelo as aceita: o arquivo
 * de jobs mora no workspace e não é confiável.
 */
export function savedJobBilling(saved: MediaVideoJobRecord): {
  resolution?: string;
  seconds?: number;
  inputImages?: number;
} {
  const spec = videoModelSpec(saved.model);
  return {
    inputImages:
      Number.isInteger(saved.inputImages) && (saved.inputImages ?? 0) >= 0 && (saved.inputImages ?? 0) <= 32
        ? saved.inputImages
        : undefined,
    resolution:
      spec && typeof saved.resolution === 'string' && spec.resolutions.includes(saved.resolution)
        ? saved.resolution
        : undefined,
    seconds:
      spec && typeof saved.durationSeconds === 'number' && spec.durations.includes(saved.durationSeconds)
        ? saved.durationSeconds
        : undefined,
  };
}

/**
 * O serviço diz que o vídeo falhou ou não existe mais (Files API `FAILED` ou
 * 404 no Gemini; `failed`/`expired` ou 404 na xAI): retomar não adianta, o job
 * vira `failed`. Qualquer outra falha depois do pedido aceito deixa o job
 * pendente (`MediaJobInterruptedError`).
 */
export class MediaJobGoneError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MediaJobGoneError';
  }
}

/**
 * Depois que o serviço aceitou (e cobra) o vídeo: só `MediaJobGoneError`
 * encerra o job; timeout segue como está; qualquer outra falha (HTTP
 * passageiro, download, disco) deixa o job pendente e devolve o
 * `recoverJobId`.
 */
export async function settleVideoJob<T>(
  job: MediaVideoJobRecord,
  req: MediaAuthorityRequest & { baseDir: string },
  run: () => Promise<T>,
): Promise<T> {
  try {
    return await run();
  } catch (err) {
    assertMediaAuthorityCurrent(req);
    if (err instanceof MediaJobTimeoutError) throw err;
    if (err instanceof MediaJobGoneError) {
      saveVideoJob(req.baseDir, { ...job, status: 'failed' });
      throw err;
    }
    throw new MediaJobInterruptedError(job.provider, job.jobId, err);
  }
}
