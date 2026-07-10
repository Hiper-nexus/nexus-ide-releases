import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import type { ProjectExecutionScope } from '../../shared/types';

/**
 * Preview server local (benchmark §7): serve um diretório estático (build de
 * app web) em 127.0.0.1:<porta aleatória>, para o agente entregar uma URL
 * clicável de preview em vez de "roda npm run dev aí".
 *
 * Segurança: só GET/HEAD, bind exclusivo em loopback, raiz fixada no spawn e
 * path traversal bloqueado por resolução canônica (o path servido PRECISA
 * continuar dentro da raiz). Um servidor por projeto + checkout + diretório
 * canônico (idempotente inclusive sob starts concorrentes).
 */

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.wasm': 'application/wasm',
  '.map': 'application/json',
  '.txt': 'text/plain; charset=utf-8',
  '.woff2': 'font/woff2',
};

interface RunningPreview {
  id: string;
  key: string;
  server: http.Server;
  port: number;
  root: string;
  projectId: string;
  checkoutId: string;
}

type PreviewScope = Pick<ProjectExecutionScope, 'projectId' | 'checkoutId'>;

export interface PreviewDescriptor {
  id: string;
  dir: string;
  url: string;
}

interface PreviewStartResult {
  id: string;
  url: string;
  port: number;
}

interface OpenedPreviewFile {
  fd: number;
  filePath: string;
  stat: fs.Stats;
}

class ForbiddenPreviewPathError extends Error {}

const runningById = new Map<string, RunningPreview>();
const previewIdByKey = new Map<string, string>();
const startingByKey = new Map<string, Promise<PreviewStartResult>>();

function previewKey(root: string, scope: PreviewScope): string {
  return JSON.stringify([scope.projectId, scope.checkoutId, root]);
}

function isOwnedBy(entry: RunningPreview, scope: PreviewScope): boolean {
  return (
    entry.projectId === scope.projectId &&
    entry.checkoutId === scope.checkoutId
  );
}

function describePreview(entry: RunningPreview): PreviewDescriptor {
  return {
    id: entry.id,
    dir: entry.root,
    url: `http://127.0.0.1:${entry.port}/`,
  };
}

function resolveSafe(root: string, urlPath: string): string | null {
  const decoded = decodeURIComponent(urlPath.split('?')[0]);
  const resolved = path.resolve(root, `.${path.posix.normalize(`/${decoded}`)}`);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) return null;
  return resolved;
}

function canonicalPathWithinRoot(root: string, candidate: string): string {
  const canonical = fs.realpathSync.native(candidate);
  const relative = path.relative(root, canonical);
  const isOutside =
    path.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${path.sep}`);
  if (isOutside) throw new ForbiddenPreviewPathError();
  return canonical;
}

function openPreviewFile(root: string, candidate: string): OpenedPreviewFile {
  let filePath = canonicalPathWithinRoot(root, candidate);
  if (fs.statSync(filePath).isDirectory()) {
    filePath = canonicalPathWithinRoot(root, path.join(filePath, 'index.html'));
  }

  const fd = fs.openSync(filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const openedStat = fs.fstatSync(fd);
    const verifiedPath = canonicalPathWithinRoot(root, filePath);
    const verifiedStat = fs.statSync(verifiedPath);
    const isSameFile = openedStat.dev === verifiedStat.dev && openedStat.ino === verifiedStat.ino;
    if (!openedStat.isFile() || !isSameFile) throw new ForbiddenPreviewPathError();
    return { fd, filePath: verifiedPath, stat: openedStat };
  } catch (error) {
    fs.closeSync(fd);
    throw error;
  }
}

function serve(root: string, req: http.IncomingMessage, res: http.ServerResponse): void {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405).end();
    return;
  }
  const candidate = resolveSafe(root, req.url ?? '/');
  if (!candidate) {
    res.writeHead(403).end('forbidden');
    return;
  }
  try {
    const { fd, filePath, stat } = openPreviewFile(root, candidate);
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream',
      'Content-Length': stat.size,
      'Cache-Control': 'no-store',
    });
    if (req.method === 'HEAD') {
      fs.closeSync(fd);
      res.end();
      return;
    }
    fs.createReadStream(filePath, { fd, autoClose: true }).pipe(res);
  } catch (error) {
    if (error instanceof ForbiddenPreviewPathError) {
      res.writeHead(403).end('forbidden');
      return;
    }
    res.writeHead(404).end('not found');
  }
}

export async function startPreview(
  dir: string,
  scope: PreviewScope,
): Promise<PreviewStartResult> {
  const root = fs.realpathSync.native(path.resolve(dir));
  const stat = fs.statSync(root); // lança se não existe — o caller traduz
  if (!stat.isDirectory()) throw new Error(`não é um diretório: ${root}`);

  const key = previewKey(root, scope);
  const existingId = previewIdByKey.get(key);
  const existing = existingId ? runningById.get(existingId) : undefined;
  if (existing) {
    return {
      id: existing.id,
      url: `http://127.0.0.1:${existing.port}/`,
      port: existing.port,
    };
  }
  if (existingId) previewIdByKey.delete(key);

  const pending = startingByKey.get(key);
  if (pending) return pending;

  const starting = createPreview(root, key, scope);
  startingByKey.set(key, starting);
  try {
    return await starting;
  } finally {
    if (startingByKey.get(key) === starting) startingByKey.delete(key);
  }
}

async function createPreview(
  root: string,
  key: string,
  scope: PreviewScope,
): Promise<PreviewStartResult> {
  const server = http.createServer((req, res) => serve(root, req, res));
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  const id = `preview-${randomUUID()}`;
  const entry: RunningPreview = {
    id,
    key,
    server,
    port,
    root,
    projectId: scope.projectId,
    checkoutId: scope.checkoutId,
  };
  runningById.set(id, entry);
  previewIdByKey.set(key, id);
  console.log(`[preview] ${id} servindo ${root} em http://127.0.0.1:${port}/`);
  return { id, url: `http://127.0.0.1:${port}/`, port };
}

export function stopPreview(id: string, scope: PreviewScope): boolean {
  const entry = runningById.get(id);
  if (!entry || !isOwnedBy(entry, scope)) return false;
  runningById.delete(id);
  if (previewIdByKey.get(entry.key) === id) previewIdByKey.delete(entry.key);
  entry.server.close();
  return true;
}

export function stopAllPreviews(): void {
  for (const entry of runningById.values()) entry.server.close();
  runningById.clear();
  previewIdByKey.clear();
  startingByKey.clear();
}

export function listPreviews(scope: PreviewScope): PreviewDescriptor[] {
  return [...runningById.values()]
    .filter((entry) => isOwnedBy(entry, scope))
    .map(describePreview);
}

/**
 * Exact loopback origins minted by this process are the only private browser
 * targets that do not need a separate user confirmation. A random localhost
 * service cannot impersonate a Nexus preview merely by using 127.0.0.1.
 */
export function isRunningPreviewUrl(raw: string | URL): boolean {
  try {
    const url = typeof raw === 'string' ? new URL(raw) : raw;
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1') return false;
    const port = Number.parseInt(url.port, 10);
    return (
      Number.isInteger(port) &&
      [...runningById.values()].some((entry) => entry.port === port)
    );
  } catch {
    return false;
  }
}

/** Process-minted preview whose canonical directory belongs to this scope. */
export function isRunningPreviewUrlForScope(
  raw: string | URL,
  scope: ProjectExecutionScope,
): boolean {
  try {
    const url = typeof raw === 'string' ? new URL(raw) : raw;
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1') return false;
    const port = Number.parseInt(url.port, 10);
    const root = fs.realpathSync.native(path.resolve(scope.rootRealPath));
    return [...runningById.values()].some((entry) => {
      if (entry.port !== port || !isOwnedBy(entry, scope)) return false;
      const relative = path.relative(root, entry.root);
      return !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`);
    });
  } catch {
    return false;
  }
}
