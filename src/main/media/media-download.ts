import {
  classifyBrowserAddress,
  resolveBrowserHostname,
  type BrowserAddressResolver,
} from '../browser/url-policy';
import https from 'node:https';
import net from 'node:net';
import { Readable } from 'node:stream';
import tls from 'node:tls';

export type DynamicMediaProvider = 'openai-image' | 'replicate-video';

export type PinnedMediaFetch = (
  url: URL,
  approvedAddresses: readonly string[],
  init: RequestInit,
) => Promise<Response>;

export interface MediaDownloadDeps {
  fetchFn: typeof fetch;
  resolveHostname: BrowserAddressResolver;
  /** Production transport that connects only to the approved numeric address. */
  fetchPinned?: PinnedMediaFetch;
}

export interface MediaDownloadLimits {
  maxBytes: number;
  timeoutMs: number;
}

const MAX_REDIRECTS = 3;
const MAX_ERROR_BODY_BYTES = 4_096;
const MAX_ERROR_DETAIL_CHARS = 400;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const DEFAULT_LIMITS: Record<DynamicMediaProvider, MediaDownloadLimits> = {
  'openai-image': { maxBytes: 64 * 1024 * 1024, timeoutMs: 120_000 },
  'replicate-video': { maxBytes: 256 * 1024 * 1024, timeoutMs: 120_000 },
};
const ALLOWED_HOST_SUFFIXES: Record<DynamicMediaProvider, string[]> = {
  'openai-image': ['openai.com', 'oaistatic.com', 'blob.core.windows.net'],
  'replicate-video': ['replicate.delivery'],
};

interface ApprovedDownloadTarget {
  url: URL;
  addresses: string[];
}

class MediaDnsTimeoutError extends Error {}

function normalizedHostname(url: URL): string {
  return url.hostname.toLowerCase().replace(/\.$/, '');
}

function isAllowedProviderHost(
  hostname: string,
  provider: DynamicMediaProvider,
): boolean {
  return ALLOWED_HOST_SUFFIXES[provider].some(
    (suffix) => hostname === suffix || hostname.endsWith(`.${suffix}`),
  );
}

async function assertSafeDownloadUrl(
  rawUrl: string,
  provider: DynamicMediaProvider,
  resolver: BrowserAddressResolver,
  timeoutMs: number,
): Promise<ApprovedDownloadTarget> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error(`${provider}: URL de download inválida`);
  }
  if (url.protocol !== 'https:') {
    throw new Error(`${provider}: download exige HTTPS`);
  }
  if (url.username || url.password) {
    throw new Error(`${provider}: URL de download contém credenciais`);
  }
  if (url.port && url.port !== '443') {
    throw new Error(`${provider}: porta de download não permitida`);
  }

  const hostname = normalizedHostname(url);
  if (!isAllowedProviderHost(hostname, provider)) {
    throw new Error(`${provider}: domínio não permitido para download`);
  }

  let addresses: string[];
  try {
    addresses = await resolveHostnameWithTimeout(
      hostname,
      resolver,
      timeoutMs,
      provider,
    );
  } catch (err) {
    if (err instanceof MediaDnsTimeoutError) throw err;
    throw new Error(`${provider}: DNS do download não pôde ser validado`);
  }
  if (
    addresses.length === 0 ||
    addresses.some((address) => classifyBrowserAddress(address) !== 'public')
  ) {
    throw new Error(`${provider}: download deve resolver apenas para rede pública`);
  }
  return { url, addresses };
}

function responseHeaders(headers: Record<string, string | string[] | undefined>): Headers {
  const result = new Headers();
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const item of value) result.append(name, item);
    } else {
      result.set(name, value);
    }
  }
  return result;
}

function requestPinnedAddress(
  url: URL,
  address: string,
  init: RequestInit,
): Promise<Response> {
  return new Promise((resolve, reject) => {
    const request = https.request(
      {
        host: address,
        family: net.isIP(address),
        port: Number(url.port || 443),
        method: init.method ?? 'GET',
        path: `${url.pathname || '/'}${url.search}`,
        headers: { Host: url.host },
        // Keep TLS identity bound to the allowlisted hostname while the TCP
        // socket is pinned to the already-validated numeric address.
        servername: url.hostname,
        checkServerIdentity: (_hostname, certificate) =>
          tls.checkServerIdentity(url.hostname, certificate),
      },
      (response) => {
        const cleanup = () => init.signal?.removeEventListener('abort', abort);
        response.once('end', cleanup);
        response.once('close', cleanup);
        response.once('error', cleanup);
        const status = response.statusCode ?? 502;
        const bodyless = status === 204 || status === 205 || status === 304;
        const body = bodyless
          ? null
          : (Readable.toWeb(response) as ReadableStream<Uint8Array>);
        resolve(new Response(body, { status, headers: responseHeaders(response.headers) }));
      },
    );
    const abort = () => request.destroy(new Error('provider download aborted'));
    if (init.signal?.aborted) {
      abort();
    } else {
      init.signal?.addEventListener('abort', abort, { once: true });
    }
    request.once('error', (error) => {
      init.signal?.removeEventListener('abort', abort);
      reject(error);
    });
    request.end();
  });
}

/**
 * Resolve once through the policy, then connect directly to one approved IP.
 * This prevents a provider hostname from rebinding to localhost/private space
 * between validation and the actual HTTPS connection.
 */
export async function fetchPinnedProviderAsset(
  url: URL,
  approvedAddresses: readonly string[],
  init: RequestInit,
): Promise<Response> {
  let lastError: unknown = new Error('provider resolved to no usable addresses');
  for (const address of approvedAddresses) {
    try {
      return await requestPinnedAddress(url, address, init);
    } catch (error) {
      if (init.signal?.aborted) throw error;
      lastError = error;
    }
  }
  throw lastError;
}

async function resolveHostnameWithTimeout(
  hostname: string,
  resolver: BrowserAddressResolver,
  timeoutMs: number,
  provider: DynamicMediaProvider,
): Promise<string[]> {
  return new Promise<string[]>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new MediaDnsTimeoutError(`${provider}: timeout no DNS do download`)),
      timeoutMs,
    );
    void resolver(hostname).then(
      (addresses) => {
        clearTimeout(timer);
        resolve(addresses);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

async function readLimitedBody(response: Response, maxBytes: number): Promise<Buffer> {
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new Error(`download excede limite de ${maxBytes} bytes`);
  }
  if (!response.body) return Buffer.alloc(0);

  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new Error(`download excede limite de ${maxBytes} bytes`);
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
}

async function downloadHop(
  target: ApprovedDownloadTarget,
  provider: DynamicMediaProvider,
  deps: MediaDownloadDeps,
  limits: MediaDownloadLimits,
): Promise<{ body?: Buffer; redirect?: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), limits.timeoutMs);
  try {
    const requestInit: RequestInit = {
      redirect: 'manual',
      signal: controller.signal,
    };
    const response = deps.fetchPinned
      ? await deps.fetchPinned(target.url, target.addresses, requestInit)
      : await deps.fetchFn(target.url.toString(), requestInit);
    if (REDIRECT_STATUSES.has(response.status)) {
      const location = response.headers.get('location');
      if (!location) throw new Error(`${provider}: redirect sem destino`);
      return { redirect: new URL(location, target.url).toString() };
    }
    if (!response.ok) {
      const detail = (await readLimitedBody(response, MAX_ERROR_BODY_BYTES))
        .toString('utf8')
        .slice(0, MAX_ERROR_DETAIL_CHARS);
      throw new Error(`${provider} download HTTP ${response.status}: ${detail}`);
    }
    return { body: await readLimitedBody(response, limits.maxBytes) };
  } catch (err) {
    if (controller.signal.aborted) {
      throw new Error(`${provider}: timeout no download`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

export async function downloadProviderAsset(
  rawUrl: string,
  provider: DynamicMediaProvider,
  deps: MediaDownloadDeps = {
    fetchFn: fetch,
    resolveHostname: resolveBrowserHostname,
    fetchPinned: fetchPinnedProviderAsset,
  },
  overrideLimits?: Partial<MediaDownloadLimits>,
): Promise<Buffer> {
  const limits = { ...DEFAULT_LIMITS[provider], ...overrideLimits };
  const deadline = Date.now() + limits.timeoutMs;
  let currentUrl = rawUrl;
  for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect += 1) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) throw new Error(`${provider}: timeout no download`);
    const target = await assertSafeDownloadUrl(
      currentUrl,
      provider,
      deps.resolveHostname,
      remainingMs,
    );
    const fetchTimeoutMs = deadline - Date.now();
    if (fetchTimeoutMs <= 0) {
      throw new Error(`${provider}: timeout no download`);
    }
    const result = await downloadHop(target, provider, deps, {
      ...limits,
      timeoutMs: fetchTimeoutMs,
    });
    if (result.body) return result.body;
    if (!result.redirect) throw new Error(`${provider}: download sem conteúdo`);
    currentUrl = result.redirect;
  }
  throw new Error(`${provider}: redirects demais no download`);
}
