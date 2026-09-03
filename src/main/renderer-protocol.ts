import { open, realpath } from 'node:fs/promises';
import path from 'node:path';
import type { CustomScheme, Protocol } from 'electron';

export const RENDERER_PROTOCOL_SCHEME = 'nexus-app';
export const RENDERER_PROTOCOL_HOST = 'bundle';
export const RENDERER_PROTOCOL_ENTRY_URL =
  `${RENDERER_PROTOCOL_SCHEME}://${RENDERER_PROTOCOL_HOST}/index.html`;

const MAX_PATHNAME_LENGTH = 4_096;
const IMMUTABLE_ASSET_RE = /-[A-Za-z0-9_-]{8,}\.[^.]+$/;

const MIME_TYPES: Readonly<Record<string, string>> = Object.freeze({
  '.css': 'text/css; charset=utf-8',
  '.gif': 'image/gif',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.otf': 'font/otf',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
});

type SchemeRegistrar = Pick<Protocol, 'registerSchemesAsPrivileged'>;
type HandlerRegistrar = Pick<Protocol, 'handle'>;

function plainResponse(
  status: number,
  body: string,
  headers: Record<string, string> = {},
): Response {
  return new Response(body, {
    status,
    headers: {
      'cache-control': 'no-store',
      'content-type': 'text/plain; charset=utf-8',
      'x-content-type-options': 'nosniff',
      ...headers,
    },
  });
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative.length > 0 &&
    relative !== '..' &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function isMissingFileError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR' || code === 'EACCES';
}

function contentTypeFor(filePath: string): string {
  return MIME_TYPES[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream';
}

/**
 * Chromium must know the scheme before `app.ready` so relative Vite assets,
 * secure-context APIs and AudioWorklet module fetches behave like a normal web
 * origin. Every privilege not listed here keeps Electron's default `false`.
 */
export function registerRendererProtocolScheme(target: SchemeRegistrar): void {
  const scheme: CustomScheme = {
    scheme: RENDERER_PROTOCOL_SCHEME,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      codeCache: true,
    },
  };
  target.registerSchemesAsPrivileged([scheme]);
}

/**
 * Serves the immutable Vite renderer from one fixed directory. URL input is
 * untrusted even though requests normally originate in our renderer: reject
 * alternate origins/methods, encoded separators and both lexical and symlink
 * escapes before reading a byte.
 */
export function createRendererProtocolHandler(
  rendererRoot: string,
): (request: Request) => Promise<Response> {
  const absoluteRoot = path.resolve(rendererRoot);
  let canonicalRoot: Promise<string> | undefined;
  const getCanonicalRoot = () => {
    canonicalRoot ??= realpath(absoluteRoot);
    return canonicalRoot;
  };

  return async (request: Request): Promise<Response> => {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return plainResponse(405, 'Method not allowed', { allow: 'GET, HEAD' });
    }

    let url: URL;
    try {
      url = new URL(request.url);
    } catch {
      return plainResponse(400, 'Bad request');
    }

    if (
      url.protocol !== `${RENDERER_PROTOCOL_SCHEME}:` ||
      url.host !== RENDERER_PROTOCOL_HOST ||
      url.username !== '' ||
      url.password !== ''
    ) {
      return plainResponse(403, 'Forbidden');
    }

    if (url.pathname.length > MAX_PATHNAME_LENGTH) {
      return plainResponse(414, 'URI too long');
    }

    let decodedPathname: string;
    try {
      decodedPathname = decodeURIComponent(url.pathname);
    } catch {
      return plainResponse(400, 'Bad request');
    }

    if (decodedPathname.includes('\0') || decodedPathname.includes('\\')) {
      return plainResponse(403, 'Forbidden');
    }

    const relativePath = decodedPathname.replace(/^\/+/, '') || 'index.html';
    const segments = relativePath.split('/').filter(Boolean);
    if (segments.some((segment) => segment === '.' || segment === '..')) {
      return plainResponse(403, 'Forbidden');
    }

    const candidate = path.resolve(absoluteRoot, ...segments);
    if (!isInside(absoluteRoot, candidate)) {
      return plainResponse(403, 'Forbidden');
    }

    let realRoot: string;
    let realCandidate: string;
    try {
      [realRoot, realCandidate] = await Promise.all([
        getCanonicalRoot(),
        realpath(candidate),
      ]);
    } catch (error) {
      return isMissingFileError(error)
        ? plainResponse(404, 'Not found')
        : plainResponse(500, 'Internal error');
    }

    if (!isInside(realRoot, realCandidate)) {
      return plainResponse(403, 'Forbidden');
    }

    let handle: Awaited<ReturnType<typeof open>> | null = null;
    try {
      // Re-resolve IMEDIATAMENTE antes de abrir: entre o realpath() da
      // checagem acima e o uso, um symlink/rename local trocaria o alvo
      // (TOCTOU — a checagem incidiria num arquivo e a leitura noutro).
      // Stat e leitura saem do MESMO fd, sem re-resolver por nome.
      const freshCandidate = await realpath(candidate);
      if (!isInside(realRoot, freshCandidate)) {
        return plainResponse(403, 'Forbidden');
      }
      handle = await open(freshCandidate, 'r');
      const fileStat = await handle.stat();
      if (!fileStat.isFile()) {
        return plainResponse(404, 'Not found');
      }

      const headers = {
        'cache-control': IMMUTABLE_ASSET_RE.test(path.basename(freshCandidate))
          ? 'public, max-age=31536000, immutable'
          : 'no-store',
        'content-length': String(fileStat.size),
        'content-type': contentTypeFor(freshCandidate),
        'cross-origin-resource-policy': 'same-origin',
        'referrer-policy': 'no-referrer',
        'x-content-type-options': 'nosniff',
      };

      if (request.method === 'HEAD') {
        return new Response(null, { status: 200, headers });
      }

      const data = await handle.readFile();
      return new Response(new Uint8Array(data), { status: 200, headers });
    } catch (error) {
      return isMissingFileError(error)
        ? plainResponse(404, 'Not found')
        : plainResponse(500, 'Internal error');
    } finally {
      await handle?.close().catch(() => {});
    }
  };
}

/** Register after `app.ready`, before creating the first BrowserWindow. */
export function installRendererProtocol(
  target: HandlerRegistrar,
  rendererRoot: string,
): void {
  target.handle(
    RENDERER_PROTOCOL_SCHEME,
    createRendererProtocolHandler(rendererRoot),
  );
}
