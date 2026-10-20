import { execFile } from 'node:child_process';

/**
 * `ffprobe` reading of a rendered/exported file (F-1594/F-1595): the Nexus
 * never reports a render as done because the process exited 0 — it reads the
 * file it promised to deliver.
 */

export interface MediaProbe {
  readonly durationSec: number | null;
  readonly sizeBytes: number | null;
  readonly formatName: string | null;
  readonly video: {
    readonly codec: string;
    readonly width: number;
    readonly height: number;
    readonly fps: number | null;
    readonly pixFmt: string | null;
    readonly profile: string | null;
  } | null;
  readonly audio: {
    readonly codec: string;
    readonly sampleRate: number | null;
    readonly channels: number | null;
  } | null;
  readonly tags: Readonly<Record<string, string>>;
}

function num(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function rate(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const [top, bottom] = value.split('/').map(Number);
  if (!Number.isFinite(top) || !Number.isFinite(bottom) || bottom === 0) return null;
  return Math.round((top / bottom) * 1000) / 1000;
}

export function parseFfprobeJson(raw: string): MediaProbe {
  const parsed = JSON.parse(raw) as {
    format?: Record<string, unknown> & { tags?: Record<string, unknown> };
    streams?: Array<Record<string, unknown>>;
  };
  const streams = Array.isArray(parsed.streams) ? parsed.streams : [];
  const video = streams.find((stream) => stream.codec_type === 'video' && stream.disposition &&
    (stream.disposition as Record<string, unknown>).attached_pic !== 1) ?? streams.find((stream) => stream.codec_type === 'video');
  const audio = streams.find((stream) => stream.codec_type === 'audio');
  const tags: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed.format?.tags ?? {})) {
    if (typeof value === 'string') tags[key.toLowerCase()] = value.slice(0, 500);
  }
  return {
    durationSec: num(parsed.format?.duration),
    sizeBytes: num(parsed.format?.size),
    formatName: typeof parsed.format?.format_name === 'string' ? parsed.format.format_name : null,
    video: video
      ? {
          codec: String(video.codec_name ?? 'unknown'),
          width: num(video.width) ?? 0,
          height: num(video.height) ?? 0,
          fps: rate(video.avg_frame_rate) ?? rate(video.r_frame_rate),
          pixFmt: typeof video.pix_fmt === 'string' ? video.pix_fmt : null,
          profile: typeof video.profile === 'string' ? video.profile : null,
        }
      : null,
    audio: audio
      ? {
          codec: String(audio.codec_name ?? 'unknown'),
          sampleRate: num(audio.sample_rate),
          channels: num(audio.channels),
        }
      : null,
    tags,
  };
}

export function probeMedia(
  ffprobe: string,
  file: string,
  env: Record<string, string>,
): Promise<MediaProbe> {
  return new Promise((resolve, reject) => {
    execFile(
      ffprobe,
      ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file],
      { env, timeout: 60_000, windowsHide: true, shell: false, maxBuffer: 8 * 1024 * 1024 },
      (error, stdout) => {
        if (error) {
          reject(new Error('ffprobe não conseguiu ler o arquivo gerado'));
          return;
        }
        try {
          resolve(parseFfprobeJson(String(stdout)));
        } catch {
          reject(new Error('ffprobe devolveu uma leitura ilegível'));
        }
      },
    );
  });
}
