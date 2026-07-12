import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  getVideoJob,
  loadVideoJobs,
  saveVideoJob,
  type MediaVideoJobRecord,
} from './media-video-jobs';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-video-jobs-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function job(over: Partial<MediaVideoJobRecord> = {}): MediaVideoJobRecord {
  return {
    jobId: 'pred-1',
    provider: 'replicate-video',
    pollTarget: 'https://api.replicate.com/v1/predictions/pred-1',
    model: 'bytedance/seedance-2.0',
    prompt: 'test',
    startedAt: 1_000,
    status: 'pending',
    ...over,
  };
}

describe('media-video-jobs', () => {
  it('persists and reloads a job under .nexus/media/', () => {
    saveVideoJob(dir, job());
    const file = path.join(dir, '.nexus', 'media', 'video-jobs.json');
    expect(fs.existsSync(file)).toBe(true);
    expect(getVideoJob(dir, 'pred-1')?.model).toBe('bytedance/seedance-2.0');
    expect(loadVideoJobs(dir)['pred-1']?.status).toBe('pending');
  });

  it('caps stored jobs at 50 newest', () => {
    for (let i = 0; i < 55; i += 1) {
      saveVideoJob(
        dir,
        job({ jobId: `j-${i}`, startedAt: 1_000 + i }),
      );
    }
    const jobs = loadVideoJobs(dir);
    expect(Object.keys(jobs)).toHaveLength(50);
    expect(jobs['j-0']).toBeUndefined();
    expect(jobs['j-54']).toBeDefined();
  });
});
