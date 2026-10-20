import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import type { CustomScheme } from 'electron';

/**
 * `nexus-media://media/<token>` (F-1596): the Estúdio's player streams a video
 * of the open workspace with HTTP Range (seek, no size cap), instead of the
 * 24 MB base64 data URL of the image preview. The renderer never names a
 * file: Main grants a random token for one path it already resolved inside
 * the workspace, and the token expires. Anything else is 403/404.
 */

export const MEDIA_STREAM_SCHEME = 'nexus-media';
const HOST = 'media';
const TOKEN_TTL_MS = 30 * 60_000;
const MAX_TOKENS = 256;

/** Registered before app.ready together with the renderer scheme. */
export const MEDIA_STREAM_SCHEME_DEF: CustomScheme = {
  scheme: MEDIA_STREAM_SCHEME,
  privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
};

const MIME: Readonly<Record<string, string>> = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.vtt': 'text/vtt; charset=utf-8',
};

interface Grant {
  readonly file: string;
  readonly expiresAt: number;
}

const grants = new Map<string, Grant>();

export function mediaStreamMime(file: string): string | null {
  return MIME[path.extname(file).toLowerCase()] ?? null;
}

/** Grant a URL for a file Main already resolved inside the workspace. */
export function grantMediaStreamUrl(file: string, now = Date.now()): string {
  if (!mediaStreamMime(file)) throw new Error('tipo de arquivo sem prévia');
  for (const [token, grant] of grants) {
    if (grant.expiresAt <= now) grants.delete(token);
  }
  while (grants.size >= MAX_TOKENS) {
    const oldest = grants.keys().next().value;
    if (oldest === undefined) break;
    grants.delete(oldest);
  }
  const token = randomBytes(16).toString('hex');
  grants.set(token, { file, expiresAt: now + TOKEN_TTL_MS });
  return `${MEDIA_STREAM_SCHEME}://${HOST}/${token}`;
}

export function resetMediaStreamGrantsForTests(): void {
  grants.clear();
}

function plain(status: number, text: string, extra: Record<string, string> = {}): Response {
  return new Response(text, {
    status,
    headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', ...extra },
  });
}

/** `bytes=a-b`, `bytes=a-`, `bytes=-n`; one range only. null = not satisfiable. */
export function parseRange(header: string, size: number): { start: number; end: number } | null {
  const match = /^bytes=(\d*)-(\d*)$/u.exec(header.trim());
  if (!match || (match[1] === '' && match[2] === '')) return null;
  let start: number;
  let end: number;
  if (match[1] === '') {
    const suffix = Number(match[2]);
    if (suffix === 0) return null;
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] === '' ? size - 1 : Math.min(Number(match[2]), size - 1);
  }
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) return null;
  return { start, end };
}

export function createMediaStreamHandler(now: () => number = Date.now) {
  return async (request: Request): Promise<Response> => {
    if (request.method !== 'GET' && request.method !== 'HEAD') return plain(405, 'Method not allowed');
    let url: URL;
    try {
      url = new URL(request.url);
    } catch {
      return plain(400, 'Bad request');
    }
    if (url.protocol !== `${MEDIA_STREAM_SCHEME}:` || url.host !== HOST || url.username || url.password) {
      return plain(403, 'Forbidden');
    }
    const token = url.pathname.replace(/^\//u, '');
    const grant = /^[a-f0-9]{32}$/u.test(token) ? grants.get(token) : undefined;
    if (!grant || grant.expiresAt <= now()) return plain(404, 'Not found');
    let stat: fs.Stats;
    try {
      stat = await fs.promises.stat(grant.file);
    } catch {
      return plain(404, 'Not found');
    }
    if (!stat.isFile()) return plain(404, 'Not found');
    const headers: Record<string, string> = {
      'content-type': mediaStreamMime(grant.file) ?? 'application/octet-stream',
      'accept-ranges': 'bytes',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    };
    const rangeHeader = request.headers.get('range');
    let start = 0;
    let end = stat.size - 1;
    let status = 200;
    if (rangeHeader) {
      const range = parseRange(rangeHeader, stat.size);
      if (!range) return plain(416, 'Range not satisfiable', { 'content-range': `bytes */${stat.size}` });
      ({ start, end } = range);
      status = 206;
      headers['content-range'] = `bytes ${start}-${end}/${stat.size}`;
    }
    headers['content-length'] = String(stat.size === 0 ? 0 : end - start + 1);
    if (request.method === 'HEAD' || stat.size === 0) return new Response(null, { status, headers });
    const stream = fs.createReadStream(grant.file, { start, end });
    return new Response(Readable.toWeb(stream) as ReadableStream, { status, headers });
  };
}
