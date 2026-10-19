import fs from 'node:fs';
import path from 'node:path';
import type { GeminiOmniUsage } from '../../shared/media-video-models';

/**
 * Persist long-running video predictions so a timed-out call can resume
 * without paying twice (ADE parity: recoverJobId).
 *
 * Jobs live under the open workspace: `.nexus/media/video-jobs.json`.
 */

export type MediaVideoJobProvider = 'replicate-video' | 'google-video' | 'xai-video';

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
  /** Tokens que o Google cobrou (Gemini Omni). */
  usage?: GeminiOmniUsage;
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
