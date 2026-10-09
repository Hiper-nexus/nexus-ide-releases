import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { WebSocketServer, type RawData, type WebSocket } from 'ws';
import type { ProjectExecutionScope } from '../../shared/types';
import {
  assertMcpInvocationCurrent,
  type McpToolInvocation,
} from './mcp-protocol';
import { previewCdpBridge, type PreviewCdpScope } from './preview-cdp-bridge';

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

interface PreviewCdpTransport {
  close: () => void;
}

interface RunningPreview {
  id: string;
  key: string;
  server: http.Server;
  port: number;
  root: string;
  projectId: string;
  checkoutId: string;
  cdp: PreviewCdpTransport;
  /** Capacidade do CDP. Não sai em nenhuma resposta HTTP do preview. */
  cdpTicket: string;
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
  /**
   * Segredo do debugger. Só quem chamou `startPreview` no processo principal
   * o recebe. `/json/version` não o inclui: a página servida não tem como obtê-lo.
   */
  cdpTicket: string;
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
const stoppingById = new Map<string, Promise<boolean>>();

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

const CDP_MAX_FRAME_BYTES = 16 * 1024 * 1024;

function cdpPaneId(url: string | undefined): string | null {
  const pathname = (url ?? '/').split('?')[0] ?? '/';
  if (!pathname.startsWith('/cdp/')) return null;
  const raw = pathname.slice('/cdp/'.length);
  if (raw.length === 0 || raw.includes('/')) return null;
  let paneId: string;
  try {
    paneId = decodeURIComponent(raw);
  } catch {
    return null;
  }
  if (paneId.length < 1 || paneId.length > 128) return null;
  if (/[/\0\\]/u.test(paneId)) return null;
  return paneId;
}

function cdpMessageText(data: RawData): string {
  if (typeof data === 'string') return data;
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  return Buffer.from(new Uint8Array(data)).toString('utf8');
}

function isCdpDiscovery(url: string | undefined): boolean {
  const pathname = (url ?? '/').split('?')[0];
  return pathname === '/json/version' || pathname === '/json/version/';
}

function writeCdpDiscovery(
  res: http.ServerResponse,
  method: string | undefined,
  scope: PreviewCdpScope,
  port: number,
): void {
  const origin = `http://127.0.0.1:${port}`;
  const paneId = previewCdpBridge()?.solePaneId(scope, origin) ?? null;
  if (!paneId) {
    res.writeHead(404, {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    res.end('not found');
    return;
  }
  const body = JSON.stringify({
    Browser: 'NexusIDE',
    'Protocol-Version': '1.3',
    webSocketDebuggerUrl: `ws://127.0.0.1:${port}/cdp/${encodeURIComponent(paneId)}`,
  });
  res.writeHead(200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  if (method === 'HEAD') res.end();
  else res.end(body);
}

function isLoopbackRemote(address: string | undefined): boolean {
  return (
    address === '127.0.0.1' ||
    address === '::1' ||
    address === '::ffff:127.0.0.1'
  );
}

function presentedCdpTicket(url: string | undefined): string | null {
  const query = url?.split('?')[1];
  if (!query) return null;
  const ticket = new URLSearchParams(query).get('ticket');
  if (!ticket || ticket.length > 128) return null;
  return ticket;
}

function cdpTicketMatches(presented: string, expected: string): boolean {
  const left = Buffer.from(presented);
  const right = Buffer.from(expected);
  if (left.length === 0 || left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

function previewStartResult(entry: RunningPreview): PreviewStartResult {
  return {
    id: entry.id,
    url: `http://127.0.0.1:${entry.port}/`,
    port: entry.port,
    cdpTicket: entry.cdpTicket,
  };
}

/**
 * URL do debugger para quem já chamou `startPreview` neste processo.
 * O ticket fica na query; `/json/version` continua sem ele.
 */
export function authorizedPreviewCdpUrl(
  scope: PreviewCdpScope,
  preview: Pick<PreviewStartResult, 'url' | 'port' | 'cdpTicket'>,
): string | null {
  if (!preview.cdpTicket || preview.cdpTicket.length > 128) return null;
  let origin: string;
  try {
    origin = new URL(preview.url).origin;
  } catch {
    return null;
  }
  const paneId = previewCdpBridge()?.solePaneId(scope, origin) ?? null;
  if (!paneId) return null;
  return `ws://127.0.0.1:${preview.port}/cdp/${encodeURIComponent(paneId)}?ticket=${encodeURIComponent(preview.cdpTicket)}`;
}

function attachPreviewCdp(
  server: http.Server,
  scope: PreviewCdpScope,
  portOf: () => number,
  ticket: string,
): PreviewCdpTransport {
  const sockets = new WebSocketServer({
    noServer: true,
    maxPayload: CDP_MAX_FRAME_BYTES,
  });
  const releases = new Set<() => void>();
  let closed = false;

  const close = () => {
    if (closed) return;
    closed = true;
    for (const release of [...releases]) release();
    for (const client of sockets.clients) client.close();
    sockets.close();
  };

  server.on('upgrade', (req, socket, head) => {
    if (closed || !isLoopbackRemote(req.socket.remoteAddress)) {
      socket.destroy();
      return;
    }
    // Upgrade vindo de página manda Origin. A página não consegue omitir esse
    // header, mas omitir ou forjar um header também não autentica: o ticket
    // abaixo não está em nenhuma resposta que o preview serve.
    if (req.headers.origin !== undefined) {
      socket.destroy();
      return;
    }
    const paneId = cdpPaneId(req.url);
    const port = portOf();
    const presented = presentedCdpTicket(req.url);
    if (
      !paneId ||
      port === 0 ||
      !presented ||
      !cdpTicketMatches(presented, ticket)
    ) {
      socket.destroy();
      return;
    }
    const origin = `http://127.0.0.1:${port}`;
    sockets.handleUpgrade(req, socket, head, (ws: WebSocket) => {
      const opened = previewCdpBridge()?.open(
        scope,
        paneId,
        origin,
        (message) => {
          if (ws.readyState === ws.OPEN) ws.send(message);
        },
      );
      if (!opened) {
        ws.close(1008, 'preview cdp unavailable');
        return;
      }
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        releases.delete(release);
        opened.detach();
      };
      releases.add(release);
      ws.on('message', (data, isBinary) => {
        if (isBinary || released) return;
        opened.connection.receive(cdpMessageText(data));
      });
      ws.once('close', release);
      ws.once('error', () => {
        release();
        if (ws.readyState === ws.OPEN) ws.close();
      });
    });
  });

  return { close };
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
  invocation?: McpToolInvocation,
): Promise<PreviewStartResult> {
  assertMcpInvocationCurrent(invocation);
  const root = fs.realpathSync.native(path.resolve(dir));
  const stat = fs.statSync(root); // lança se não existe — o caller traduz
  if (!stat.isDirectory()) throw new Error(`não é um diretório: ${root}`);

  const key = previewKey(root, scope);
  const existingId = previewIdByKey.get(key);
  const existing = existingId ? runningById.get(existingId) : undefined;
  if (existing) {
    assertMcpInvocationCurrent(invocation);
    return previewStartResult(existing);
  }
  if (existingId) previewIdByKey.delete(key);

  const pending = startingByKey.get(key);
  if (pending) return pending;

  const starting = createPreview(root, key, scope, invocation);
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
  invocation?: McpToolInvocation,
): Promise<PreviewStartResult> {
  let port = 0;
  const cdpTicket = randomBytes(32).toString('base64url');
  const server = http.createServer((req, res) => {
    if (isCdpDiscovery(req.url)) {
      writeCdpDiscovery(res, req.method, scope, port);
      return;
    }
    serve(root, req, res);
  });
  const cdp = attachPreviewCdp(server, scope, () => port, cdpTicket);
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      invocation?.signal?.removeEventListener('abort', onAbort);
      server.off('error', onError);
    };
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      try {
        cdp.close();
        server.close();
      } catch {
        // A listener revoked before bind has no physical server to close.
      }
      reject(error);
    };
    const onAbort = () => fail(new Error('session_authority_revoked'));
    const onError = (error: Error) => fail(error);
    invocation?.signal?.addEventListener('abort', onAbort, { once: true });
    server.once('error', onError);
    try {
      assertMcpInvocationCurrent(invocation);
      server.listen(0, '127.0.0.1', () => {
        try {
          assertMcpInvocationCurrent(invocation);
          if (settled) return;
          const address = server.address();
          port = typeof address === 'object' && address ? address.port : 0;
          settled = true;
          cleanup();
          resolve();
        } catch (error) {
          fail(error);
        }
      });
    } catch (error) {
      fail(error);
    }
  });
  try {
    assertMcpInvocationCurrent(invocation);
  } catch (error) {
    cdp.close();
    server.close();
    throw error;
  }
  const id = `preview-${randomUUID()}`;
  const entry: RunningPreview = {
    id,
    key,
    server,
    port,
    root,
    projectId: scope.projectId,
    checkoutId: scope.checkoutId,
    cdp,
    cdpTicket,
  };
  runningById.set(id, entry);
  previewIdByKey.set(key, id);
  console.log(`[preview] ${id} servindo ${root} em http://127.0.0.1:${port}/`);
  return previewStartResult(entry);
}

export function stopPreview(id: string, scope: PreviewScope): boolean {
  const entry = runningById.get(id);
  if (!entry || !isOwnedBy(entry, scope) || stoppingById.has(id)) return false;
  runningById.delete(id);
  if (previewIdByKey.get(entry.key) === id) previewIdByKey.delete(entry.key);
  entry.cdp.close();
  entry.server.close();
  return true;
}

/**
 * Main-owned teardown used by privileged automated review. Unlike the public
 * tool response, this does not report success until the loopback listener has
 * emitted physical close proof.
 */
export async function stopPreviewWithProof(
  id: string,
  scope: PreviewScope,
): Promise<boolean> {
  const entry = runningById.get(id);
  if (!entry || !isOwnedBy(entry, scope)) return false;
  const pending = stoppingById.get(id);
  if (pending) return pending;
  const stopping = (async () => {
    entry.cdp.close();
    await new Promise<void>((resolve, reject) => {
      try {
        entry.server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
        entry.server.closeIdleConnections?.();
      } catch (error) {
        reject(error);
      }
    });
    if (runningById.get(id) === entry) runningById.delete(id);
    if (previewIdByKey.get(entry.key) === id) previewIdByKey.delete(entry.key);
    return true;
  })();
  stoppingById.set(id, stopping);
  try {
    return await stopping;
  } finally {
    if (stoppingById.get(id) === stopping) stoppingById.delete(id);
  }
}

export function stopAllPreviews(): void {
  for (const entry of runningById.values()) {
    entry.cdp.close();
    entry.server.close();
  }
  runningById.clear();
  previewIdByKey.clear();
  startingByKey.clear();
  stoppingById.clear();
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

/**
 * Stronger form used by the automated design-review capability: both the
 * opaque main-minted preview id and its exact loopback URL must still resolve
 * to one running preview rooted inside the reviewer's execution checkout.
 */
export function isRunningPreviewDescriptorForScope(
  id: string,
  raw: string | URL,
  scope: ProjectExecutionScope,
): boolean {
  const entry = runningById.get(id);
  if (!entry || !isOwnedBy(entry, scope)) return false;
  try {
    const url = typeof raw === 'string' ? new URL(raw) : raw;
    const expected = describePreview(entry).url;
    if (url.href !== expected) return false;
    const root = fs.realpathSync.native(path.resolve(scope.rootRealPath));
    const relative = path.relative(root, entry.root);
    return (
      !path.isAbsolute(relative) &&
      relative !== '..' &&
      !relative.startsWith(`..${path.sep}`)
    );
  } catch {
    return false;
  }
}
