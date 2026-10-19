import {
  classifyBrowserAddress,
  resolveBrowserHostname,
  type BrowserAddressResolver,
} from '../browser/url-policy';
import https from 'node:https';
import net from 'node:net';
import { Readable } from 'node:stream';
import tls from 'node:tls';

export type DynamicMediaProvider =
  'openai-image' | 'replicate-image' | 'replicate-video' | 'google-video' | 'xai-video';

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
  'replicate-image': { maxBytes: 64 * 1024 * 1024, timeoutMs: 120_000 },
  'replicate-video': { maxBytes: 256 * 1024 * 1024, timeoutMs: 120_000 },
  'google-video': { maxBytes: 256 * 1024 * 1024, timeoutMs: 120_000 },
  'xai-video': { maxBytes: 256 * 1024 * 1024, timeoutMs: 120_000 },
};
const ALLOWED_HOST_SUFFIXES: Record<DynamicMediaProvider, string[]> = {
  'openai-image': ['openai.com', 'oaistatic.com', 'blob.core.windows.net'],
  'replicate-image': ['replicate.delivery'],
  'replicate-video': ['replicate.delivery'],
  'google-video': [
    'googleapis.com',
    'googleusercontent.com',
    'gstatic.com',
    'storage.googleapis.com',
  ],
  // F-1599: o vídeo do Grok Imagine é uma URL temporária e pública em
  // `vidgen.x.ai` (docs.x.ai, resposta do `GET /v1/videos/{id}`); baixada sem
  // a chave. Só esse host, nunca o `x.ai` inteiro.
  'xai-video': ['vidgen.x.ai'],
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
  signal?: AbortSignal,
): Promise<ApprovedDownloadTarget> {
  signal?.throwIfAborted();
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
      signal,
    );
  } catch (err) {
    if (err instanceof MediaDnsTimeoutError) throw err;
    throw new Error(`${provider}: DNS do download não pôde ser validado`);
  }
  if (
    addresses.length === 0 ||
    addresses.some((address) => classifyBrowserAddress(address) !== 'public')
  ) {
    throw new Error(
      `${provider}: download deve resolver apenas para rede pública`,
    );
  }
  return { url, addresses };
}

function responseHeaders(
  headers: Record<string, string | string[] | undefined>,
): Headers {
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
        headers: { ...Object.fromEntries(new Headers(init.headers)), Host: url.host },
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
        resolve(
          new Response(body, {
            status,
            headers: responseHeaders(response.headers),
          }),
        );
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
  let lastError: unknown = new Error(
    'provider resolved to no usable addresses',
  );
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
  signal?: AbortSignal,
): Promise<string[]> {
  return new Promise<string[]>((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout>;
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };
    const succeed = (addresses: string[]) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(addresses);
    };
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const onAbort = () => {
      fail(
        signal?.reason instanceof Error
          ? signal.reason
          : new Error(`${provider}: download abortado`),
      );
    };
    timer = setTimeout(
      () =>
        fail(
          new MediaDnsTimeoutError(`${provider}: timeout no DNS do download`),
        ),
      timeoutMs,
    );
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener('abort', onAbort, { once: true });
    void resolver(hostname).then(succeed, fail);
  });
}

async function readLimitedBody(
  response: Response,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<Buffer> {
  signal?.throwIfAborted();
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
      signal?.throwIfAborted();
      const { done, value } = await reader.read();
      signal?.throwIfAborted();
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
  signal?: AbortSignal,
  headers?: Readonly<Record<string, string>>,
): Promise<{ body?: Buffer; redirect?: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), limits.timeoutMs);
  const requestSignal = signal
    ? AbortSignal.any([controller.signal, signal])
    : controller.signal;
  try {
    const requestInit: RequestInit = {
      redirect: 'manual',
      signal: requestSignal,
      ...(headers ? { headers: { ...headers } } : {}),
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
      const detail = (
        await readLimitedBody(response, MAX_ERROR_BODY_BYTES, requestSignal)
      )
        .toString('utf8')
        .slice(0, MAX_ERROR_DETAIL_CHARS);
      throw new Error(
        `${provider} download HTTP ${response.status}: ${detail}`,
      );
    }
    return {
      body: await readLimitedBody(response, limits.maxBytes, requestSignal),
    };
  } catch (err) {
    if (signal?.aborted) throw err;
    if (controller.signal.aborted) {
      throw new Error(`${provider}: timeout no download`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

function defaultDownloadDeps(): MediaDownloadDeps {
  return {
    fetchFn: fetch,
    resolveHostname: resolveBrowserHostname,
    fetchPinned: fetchPinnedProviderAsset,
  };
}

export async function downloadProviderAsset(
  rawUrl: string,
  provider: DynamicMediaProvider,
  deps: MediaDownloadDeps = defaultDownloadDeps(),
  overrideLimits?: Partial<MediaDownloadLimits>,
  signal?: AbortSignal,
): Promise<Buffer> {
  return downloadWithPolicy(rawUrl, provider, deps, overrideLimits, signal);
}

/**
 * Download que exige a credencial do serviço (Files API do Gemini, F-1587).
 * A credencial vai só no primeiro salto e só se a URL for do host que o
 * chamador montou (`credentialHost`); um redirect segue pela mesma política
 * de host e DNS, sem a credencial.
 */
export async function downloadAuthenticatedProviderAsset(
  rawUrl: string,
  provider: DynamicMediaProvider,
  credential: { host: string; headers: Readonly<Record<string, string>> },
  deps: MediaDownloadDeps = defaultDownloadDeps(),
  signal?: AbortSignal,
): Promise<Buffer> {
  let hostname: string;
  try {
    hostname = normalizedHostname(new URL(rawUrl));
  } catch {
    throw new Error(`${provider}: URL de download inválida`);
  }
  if (hostname !== credential.host.toLowerCase()) {
    throw new Error(`${provider}: credencial só vai para ${credential.host}`);
  }
  return downloadWithPolicy(rawUrl, provider, deps, undefined, signal, credential.headers);
}

async function downloadWithPolicy(
  rawUrl: string,
  provider: DynamicMediaProvider,
  deps: MediaDownloadDeps,
  overrideLimits: Partial<MediaDownloadLimits> | undefined,
  signal: AbortSignal | undefined,
  firstHopHeaders?: Readonly<Record<string, string>>,
): Promise<Buffer> {
  signal?.throwIfAborted();
  const limits = { ...DEFAULT_LIMITS[provider], ...overrideLimits };
  const deadline = Date.now() + limits.timeoutMs;
  let currentUrl = rawUrl;
  for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect += 1) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) throw new Error(`${provider}: timeout no download`);
    signal?.throwIfAborted();
    const target = await assertSafeDownloadUrl(
      currentUrl,
      provider,
      deps.resolveHostname,
      remainingMs,
      signal,
    );
    signal?.throwIfAborted();
    const fetchTimeoutMs = deadline - Date.now();
    if (fetchTimeoutMs <= 0) {
      throw new Error(`${provider}: timeout no download`);
    }
    const result = await downloadHop(
      target,
      provider,
      deps,
      {
        ...limits,
        timeoutMs: fetchTimeoutMs,
      },
      signal,
      redirect === 0 ? firstHopHeaders : undefined,
    );
    if (result.body) return result.body;
    if (!result.redirect) throw new Error(`${provider}: download sem conteúdo`);
    currentUrl = result.redirect;
  }
  throw new Error(`${provider}: redirects demais no download`);
}
