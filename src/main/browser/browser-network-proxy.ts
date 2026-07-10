import http, {
  type IncomingHttpHeaders,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import net, { type Socket } from 'node:net';
import type { Duplex } from 'node:stream';
import type { Session } from 'electron';
import {
  assessBrowserUrl,
  browserAddressesMatchPrivatePins,
  browserNetworkTargetKey,
  normalizeBrowserUrl,
  type BrowserAddressResolver,
  type BrowserUrlBlockKind,
} from './url-policy';

/**
 * Per-pane, fail-closed network boundary for remote WebContents.
 *
 * A webRequest DNS check cannot prevent Chromium from resolving the hostname
 * again when it opens the socket. This proxy performs policy resolution and
 * then connects Node directly to one of those exact numeric addresses. HTTP
 * keeps the original Host header; HTTPS/WSS use a transparent CONNECT tunnel,
 * so Chromium still owns TLS verification and sends the original SNI.
 */

const PROXY_HOST = '127.0.0.1';
const CONNECT_TIMEOUT_MS = 10_000;
const MAX_PROXY_CONNECTIONS = 64;
const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

export interface PinnedBrowserProxyPolicy {
  resolver: BrowserAddressResolver;
  privateTargetAddresses: (
    targetKey: string,
  ) => ReadonlySet<string> | undefined;
  isTrustedPrivateUrl: (url: URL) => boolean;
}

export interface PinnedBrowserTarget {
  url: URL;
  hostname: string;
  port: number;
  addresses: string[];
}

export interface PinnedBrowserProxy {
  port: number;
  proxyRules: string;
  close(): Promise<void>;
}

type ProxySession = Pick<Session, 'setProxy' | 'closeAllConnections'>;

class BrowserProxyPolicyError extends Error {
  constructor(readonly kind: BrowserUrlBlockKind) {
    super(`browser proxy blocked target (${kind})`);
    this.name = 'BrowserProxyPolicyError';
  }
}

function normalizedTargetKey(rawUrl: string): string {
  try {
    return browserNetworkTargetKey(
      normalizeBrowserUrl(rawUrl, { requestProtocols: true }),
    );
  } catch {
    return '';
  }
}

function targetPort(url: URL): number {
  if (url.port) return Number(url.port);
  return url.protocol === 'https:' || url.protocol === 'wss:' ? 443 : 80;
}

export async function resolvePinnedBrowserTarget(
  rawUrl: string,
  policy: PinnedBrowserProxyPolicy,
): Promise<PinnedBrowserTarget> {
  const targetKey = normalizedTargetKey(rawUrl);
  const approvedPrivateAddresses = policy.privateTargetAddresses(targetKey);
  const decision = await assessBrowserUrl(rawUrl, {
    requestProtocols: true,
    resolver: policy.resolver,
    allowPrivateNetwork: Boolean(approvedPrivateAddresses?.size),
    isTrustedPrivateUrl: policy.isTrustedPrivateUrl,
  });
  if (!decision.allowed) throw new BrowserProxyPolicyError(decision.kind);
  const url = new URL(decision.normalizedUrl);
  if (
    !policy.isTrustedPrivateUrl(url) &&
    !browserAddressesMatchPrivatePins(
      decision.addresses,
      decision.addressClasses,
      approvedPrivateAddresses,
    )
  ) {
    throw new BrowserProxyPolicyError('private-network');
  }
  const addresses = [...new Set(decision.addresses)];
  if (
    addresses.length === 0 ||
    addresses.some((address) => net.isIP(address) === 0)
  ) {
    throw new BrowserProxyPolicyError('dns-failure');
  }
  const port = targetPort(url);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new BrowserProxyPolicyError('invalid-url');
  }
  return {
    url,
    hostname: url.hostname.replace(/^\[|\]$/g, ''),
    port,
    addresses,
  };
}

function sanitizedHeaders(
  headers: IncomingHttpHeaders,
  preserveUpgrade: boolean,
): IncomingHttpHeaders {
  const safe: IncomingHttpHeaders = {};
  const connectionTokens = new Set(
    String(headers.connection ?? '')
      .split(',')
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean),
  );
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    const isRequiredUpgradeHeader =
      preserveUpgrade && (lower === 'connection' || lower === 'upgrade');
    if (
      lower.startsWith('proxy-') ||
      ((HOP_BY_HOP_HEADERS.has(lower) || connectionTokens.has(lower)) &&
        !isRequiredUpgradeHeader)
    ) {
      continue;
    }
    safe[lower] = value;
  }
  return safe;
}

function respondBlocked(response: ServerResponse, error: unknown): void {
  const status = error instanceof BrowserProxyPolicyError ? 403 : 502;
  const body =
    status === 403 ? 'blocked by browser network policy' : 'proxy unavailable';
  if (response.headersSent) {
    response.destroy();
    return;
  }
  response.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    Connection: 'close',
  });
  response.end(body);
}

function socketResponse(socket: Duplex, status: 400 | 403 | 502): void {
  const reason =
    status === 400 ? 'Bad Request' : status === 403 ? 'Forbidden' : 'Bad Gateway';
  const body =
    status === 403 ? 'blocked by browser network policy' : reason.toLowerCase();
  socket.end(
    `HTTP/1.1 ${status} ${reason}\r\n` +
      'Content-Type: text/plain; charset=utf-8\r\n' +
      `Content-Length: ${Buffer.byteLength(body)}\r\n` +
      'Connection: close\r\n\r\n' +
      body,
  );
}

function requestPath(url: URL): string {
  return `${url.pathname || '/'}${url.search}`;
}

async function forwardHttpRequest(
  request: IncomingMessage,
  response: ServerResponse,
  policy: PinnedBrowserProxyPolicy,
): Promise<void> {
  const target = await resolvePinnedBrowserTarget(request.url ?? '', policy);
  if (target.url.protocol !== 'http:') {
    throw new BrowserProxyPolicyError('unsafe-scheme');
  }
  const address = target.addresses[0];
  const headers = sanitizedHeaders(request.headers, false);
  headers.host = target.url.host;
  const upstream = http.request({
    host: address,
    family: net.isIP(address),
    port: target.port,
    method: request.method,
    path: requestPath(target.url),
    headers,
    agent: false,
  });
  upstream.setTimeout(CONNECT_TIMEOUT_MS, () => {
    upstream.destroy(new Error('browser proxy upstream timeout'));
  });
  upstream.once('response', (upstreamResponse) => {
    response.writeHead(
      upstreamResponse.statusCode ?? 502,
      sanitizedHeaders(upstreamResponse.headers, false),
    );
    upstreamResponse.once('error', () => response.destroy());
    upstreamResponse.pipe(response);
  });
  upstream.once('error', (error) => respondBlocked(response, error));
  request.once('aborted', () => upstream.destroy());
  request.pipe(upstream);
}

function connectAddress(address: string, port: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: address, port, family: net.isIP(address) });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error('browser proxy connect timeout'));
    }, CONNECT_TIMEOUT_MS);
    timer.unref?.();
    socket.once('connect', () => {
      clearTimeout(timer);
      socket.setNoDelay(true);
      resolve(socket);
    });
    socket.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

async function connectPinned(target: PinnedBrowserTarget): Promise<Socket> {
  let lastError: unknown = new Error('target resolved to no usable addresses');
  for (const address of target.addresses) {
    try {
      return await connectAddress(address, target.port);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

function connectTargetUrl(authority: string): string {
  if (
    !authority ||
    /[\s/?#@]/.test(authority) ||
    authority.length > 512
  ) {
    throw new BrowserProxyPolicyError('invalid-url');
  }
  return `https://${authority}/`;
}

async function forwardConnect(
  request: IncomingMessage,
  client: Duplex,
  head: Buffer,
  policy: PinnedBrowserProxyPolicy,
): Promise<void> {
  try {
    const target = await resolvePinnedBrowserTarget(
      connectTargetUrl(request.url ?? ''),
      policy,
    );
    const upstream = await connectPinned(target);
    if (client.destroyed) {
      upstream.destroy();
      return;
    }
    client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (head.length > 0) upstream.write(head);
    client.once('error', () => upstream.destroy());
    upstream.once('error', () => client.destroy());
    client.pipe(upstream);
    upstream.pipe(client);
  } catch (error) {
    socketResponse(client, error instanceof BrowserProxyPolicyError ? 403 : 502);
  }
}

function serializeUpgradeRequest(
  request: IncomingMessage,
  target: PinnedBrowserTarget,
): string {
  const headers = sanitizedHeaders(request.headers, true);
  headers.host = target.url.host;
  const lines = [
    `${request.method ?? 'GET'} ${requestPath(target.url)} HTTP/${request.httpVersion}`,
  ];
  for (const [name, value] of Object.entries(headers)) {
    if (Array.isArray(value)) {
      for (const item of value) lines.push(`${name}: ${item}`);
    } else if (value !== undefined) {
      lines.push(`${name}: ${value}`);
    }
  }
  return `${lines.join('\r\n')}\r\n\r\n`;
}

async function forwardUpgrade(
  request: IncomingMessage,
  client: Duplex,
  head: Buffer,
  policy: PinnedBrowserProxyPolicy,
): Promise<void> {
  try {
    const target = await resolvePinnedBrowserTarget(request.url ?? '', policy);
    if (target.url.protocol !== 'ws:' && target.url.protocol !== 'http:') {
      throw new BrowserProxyPolicyError('unsafe-scheme');
    }
    const upstream = await connectPinned(target);
    if (client.destroyed) {
      upstream.destroy();
      return;
    }
    upstream.write(serializeUpgradeRequest(request, target));
    if (head.length > 0) upstream.write(head);
    client.once('error', () => upstream.destroy());
    upstream.once('error', () => client.destroy());
    client.pipe(upstream);
    upstream.pipe(client);
  } catch (error) {
    socketResponse(client, error instanceof BrowserProxyPolicyError ? 403 : 502);
  }
}

export async function startPinnedBrowserProxy(
  policy: PinnedBrowserProxyPolicy,
): Promise<PinnedBrowserProxy> {
  const sockets = new Set<Socket>();
  const server = http.createServer((request, response) => {
    void forwardHttpRequest(request, response, policy).catch((error) => {
      respondBlocked(response, error);
    });
  });
  server.maxConnections = MAX_PROXY_CONNECTIONS;
  server.headersTimeout = 10_000;
  server.requestTimeout = 30_000;
  server.keepAliveTimeout = 5_000;
  server.on('connect', (request, client, head) => {
    void forwardConnect(request, client, head, policy);
  });
  server.on('upgrade', (request, client, head) => {
    void forwardUpgrade(request, client, head, policy);
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  server.on('clientError', (_error, socket) => socketResponse(socket, 400));
  // A late server error must fail the pane's network boundary, not crash the
  // Electron main process via an unhandled EventEmitter "error" event.
  server.on('error', () => {});

  const port = await new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, PROXY_HOST, () => {
      server.off('error', reject);
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('browser proxy failed to bind a TCP port'));
        return;
      }
      resolve(address.port);
    });
  });
  let closePromise: Promise<void> | null = null;
  return {
    port,
    proxyRules: `http://${PROXY_HOST}:${port}`,
    close: () => {
      if (closePromise) return closePromise;
      closePromise = new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      });
      return closePromise;
    },
  };
}

export async function installPinnedBrowserProxy(
  session: ProxySession,
  policy: PinnedBrowserProxyPolicy,
): Promise<PinnedBrowserProxy> {
  const proxy = await startPinnedBrowserProxy(policy);
  try {
    await session.setProxy({
      mode: 'fixed_servers',
      proxyRules: proxy.proxyRules,
      // Chromium otherwise bypasses proxies implicitly for localhost and
      // link-local literals. Our proxy validates these too (including the
      // exact Nexus preview allowlist), so no network request needs a direct
      // fallback around the pinned boundary.
      proxyBypassRules: '<-loopback>',
    });
    // Electron documents this as necessary to prevent pooled sockets from the
    // previous proxy configuration being reused by later requests.
    await session.closeAllConnections();
    return proxy;
  } catch (error) {
    await proxy.close();
    throw error;
  }
}
