import { z } from 'zod';

/**
 * Lightweight typed client for the designmd.ai REST API.
 *
 * We deliberately do NOT depend on the `designmd-mcp` package: its surface is a
 * thin wrapper around this same HTTP API, and pulling it into the main-process
 * bundle would add supply-chain/version-coupling risk for no meaningful gain.
 *
 * Auth is resolved from the encrypted vault (`external:designmd-api-key`) and
 * never passed through subprocess environment variables.
 */

export const DESIGNMD_BASE_URL = 'https://designmd.ai/api/v1';
export const DESIGNMD_API_KEY_SECRET = 'external:designmd-api-key';

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_RESPONSE_BUDGET = 256 * 1024;
const MAX_RESPONSE_BUDGET = 1024 * 1024;

const licenseSchema = z.enum([
  'mit',
  'cc0',
  'cc-by',
  'cc-by-sa',
  'proprietary',
  'unknown',
]).catch('unknown');

const kitSummarySchema = z.object({
  slug: z.string().trim().min(1).max(512),
  name: z.string().trim().min(1).max(512),
  description: z.string().max(8_192).default(''),
  author: z.string().trim().max(512).default(''),
  url: z.string().url().max(4_096).default('https://designmd.ai'),
  tags: z.array(z.string().trim().min(1).max(128)).default([]),
  license: licenseSchema,
  downloadCount: z.number().int().nonnegative().default(0),
  likeCount: z.number().int().nonnegative().default(0),
}).strict();

const kitDetailSchema = kitSummarySchema.extend({
  content: z.string().max(1024 * 1024),
}).strict();

export type DesignMdKitSummary = z.infer<typeof kitSummarySchema>;
export type DesignMdKitDetail = z.infer<typeof kitDetailSchema>;
export type DesignMdLicense = z.infer<typeof licenseSchema>;

export interface DesignMdApiDeps {
  readonly baseUrl: string;
  readonly fetchFn: typeof fetch;
  readonly getApiKey: () => string | null;
}

function defaultDeps(): DesignMdApiDeps {
  // Lazy require: secrets-store touches electron/safeStorage and must not be
  // imported at the top level in test/browser bundles.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const secrets = require('../persistence/secrets-store') as typeof import('../persistence/secrets-store');
  return {
    baseUrl: DESIGNMD_BASE_URL,
    fetchFn: fetch,
    getApiKey: () => secrets.getSecret(DESIGNMD_API_KEY_SECRET),
  };
}

function urlFor(deps: DesignMdApiDeps, path: string): string {
  return `${deps.baseUrl.replace(/\/+$/, '')}${path.startsWith('/') ? path : `/${path}`}`;
}

export class DesignMdAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DesignMdAuthError';
  }
}

export class DesignMdApiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DesignMdApiError';
  }
}

export class DesignMdLicenseError extends Error {
  readonly license: DesignMdLicense;

  constructor(license: DesignMdLicense, message: string) {
    super(message);
    this.name = 'DesignMdLicenseError';
    this.license = license;
  }
}

async function boundedJson(
  response: Response,
  maxBytes: number = DEFAULT_RESPONSE_BUDGET,
): Promise<unknown> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_RESPONSE_BUDGET) {
    throw new DesignMdApiError('invalid API response budget');
  }
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new DesignMdApiError('API response exceeds byte budget');
  }
  if (!response.body) return null;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      total += part.value.byteLength;
      if (total > maxBytes) {
        await reader.cancel('response byte budget exceeded');
        throw new DesignMdApiError('API response exceeds byte budget');
      }
      chunks.push(part.value);
    }
  } finally {
    reader.releaseLock();
  }
  if (total === 0) return null;
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    throw new DesignMdApiError('API response is not valid JSON');
  }
}

async function apiRequest(
  path: string,
  init: RequestInit = {},
  deps: DesignMdApiDeps,
  { auth = false, maxBytes }: { auth?: boolean; maxBytes?: number } = {},
): Promise<unknown> {
  const headers = new Headers(init.headers);
  headers.set('accept', 'application/json');
  if (auth) {
    const key = deps.getApiKey();
    if (!key) {
      throw new DesignMdAuthError(
        'DesignMd API key not configured: store external:designmd-api-key in Nexus secrets',
      );
    }
    headers.set('authorization', `Bearer ${key}`);
  }

  let response: Response;
  try {
    response = await deps.fetchFn(urlFor(deps, path), {
      ...init,
      headers,
      signal: init.signal ?? AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
    });
  } catch (error) {
    if (error instanceof Error && error.name === 'TimeoutError') {
      throw new DesignMdApiError('DesignMd API request timed out');
    }
    throw new DesignMdApiError(
      `DesignMd API request failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (response.status === 401 || response.status === 403) {
    throw new DesignMdAuthError(`DesignMd API returned ${response.status}`);
  }
  if (!response.ok) {
    throw new DesignMdApiError(`DesignMd API returned ${response.status}`);
  }

  return boundedJson(response, maxBytes);
}

function parseKitSummary(value: unknown): DesignMdKitSummary {
  return kitSummarySchema.parse(value);
}

function parseKitDetail(value: unknown): DesignMdKitDetail {
  return kitDetailSchema.parse(value);
}

function parseKitList(body: unknown): DesignMdKitSummary[] {
  const payload = typeof body === 'object' && body !== null && 'data' in body
    ? (body as Record<string, unknown>).data
    : body;
  const list = Array.isArray(payload) ? payload : [];
  return list.map(parseKitSummary);
}

function parseTagList(body: unknown): string[] {
  const payload = typeof body === 'object' && body !== null && 'data' in body
    ? (body as Record<string, unknown>).data
    : body;
  const list = Array.isArray(payload) ? payload : [];
  return list.filter((item): item is string => typeof item === 'string');
}

export interface DesignMdSearchOptions {
  readonly query?: string;
  readonly tags?: readonly string[];
  readonly sort?: 'popular' | 'recent' | 'likes' | 'downloads';
  readonly limit?: number;
}

export class DesignMdApiClient {
  readonly #deps: DesignMdApiDeps;

  constructor(deps: Partial<DesignMdApiDeps> = {}) {
    // Only touch the vault-backed defaults when a field is actually missing.
    // This keeps tests and browser bundles from pulling in electron/safeStorage.
    if (deps.baseUrl !== undefined && deps.fetchFn !== undefined && deps.getApiKey !== undefined) {
      this.#deps = deps as DesignMdApiDeps;
    } else {
      const defaults = defaultDeps();
      this.#deps = {
        baseUrl: deps.baseUrl ?? defaults.baseUrl,
        fetchFn: deps.fetchFn ?? defaults.fetchFn,
        getApiKey: deps.getApiKey ?? defaults.getApiKey,
      };
    }
  }

  async searchKits(options: DesignMdSearchOptions = {}): Promise<DesignMdKitSummary[]> {
    const params = new URLSearchParams();
    if (options.query) params.set('q', options.query);
    if (options.tags && options.tags.length > 0) {
      for (const tag of options.tags) params.append('tag', tag);
    }
    if (options.sort) params.set('sort', options.sort);
    if (options.limit !== undefined) params.set('limit', String(options.limit));
    const query = params.toString();
    const path = query ? `/kits?${query}` : '/kits';
    const body = await apiRequest(path, {}, this.#deps);
    return parseKitList(body);
  }

  async listPopularKits(limit?: number): Promise<DesignMdKitSummary[]> {
    const params = limit !== undefined ? `?limit=${encodeURIComponent(String(limit))}` : '';
    const body = await apiRequest(`/kits/popular${params}`, {}, this.#deps);
    return parseKitList(body);
  }

  async listTags(): Promise<string[]> {
    const body = await apiRequest('/tags', {}, this.#deps);
    return parseTagList(body);
  }

  async getKit(identifier: string): Promise<DesignMdKitDetail> {
    const normalized = identifier.trim();
    if (!normalized || normalized.length > 512) {
      throw new DesignMdApiError('invalid kit identifier');
    }
    // Accept either `user/slug` or a full designmd.ai URL.
    const slug = normalized.replace(/^https:\/\/designmd\.ai\//, '').replace(/^\/+/, '');
    if (!slug || slug.includes('..') || slug.includes('//')) {
      throw new DesignMdApiError('invalid kit identifier');
    }
    const body = await apiRequest(
      `/kits/${encodeURIComponent(slug)}`,
      {},
      this.#deps,
      { auth: true, maxBytes: 1024 * 1024 },
    );
    return parseKitDetail(body);
  }
}
