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
/** Search/tag/list responses can list many kits; give them the same 1 MiB
 * ceiling used for full kit downloads so the UI's 50-result page does not
 * trip the byte budget on long descriptions. */
const LIST_RESPONSE_BUDGET = 1024 * 1024;

const licenseSchema = z.enum([
  'mit',
  'cc0',
  'cc-by',
  'cc-by-sa',
  'proprietary',
  'unknown',
]).catch('unknown');

/**
 * designmd.ai returns snake_case fields and nested author objects. Normalize
 * into a stable camelCase summary used by Nexus tools/UI. Matches the official
 * designmd CLI mapping (author.username, download_count, like_count).
 */
const authorSchema = z.union([
  z.string().trim().max(512),
  z.object({
    username: z.string().trim().max(512).optional(),
    display_name: z.string().trim().max(512).optional(),
    displayName: z.string().trim().max(512).optional(),
    avatar_url: z.string().max(4_096).optional(),
    avatarUrl: z.string().max(4_096).optional(),
  }).passthrough(),
]);

function authorToString(author: z.infer<typeof authorSchema> | undefined): string {
  if (typeof author === 'string') return author.trim();
  if (!author || typeof author !== 'object') return '';
  const username = typeof author.username === 'string' ? author.username.trim() : '';
  if (username) return username;
  const display =
    (typeof author.display_name === 'string' && author.display_name.trim()) ||
    (typeof author.displayName === 'string' && author.displayName.trim()) ||
    '';
  return display;
}

function pickString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

function pickNonNegativeInt(...values: unknown[]): number {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
      return Math.floor(value);
    }
  }
  return 0;
}

const kitSummarySchema = z
  .object({
    id: z.string().optional(),
    slug: z.string().trim().min(1).max(512),
    name: z.string().trim().min(1).max(512),
    description: z.string().max(8_192).optional(),
    author: authorSchema.optional(),
    author_username: z.string().trim().max(512).optional(),
    url: z.string().max(4_096).optional(),
    tags: z.array(z.string().trim().min(1).max(128)).optional(),
    license: licenseSchema.optional(),
    downloadCount: z.number().optional(),
    download_count: z.number().optional(),
    likeCount: z.number().optional(),
    like_count: z.number().optional(),
    preview_colors: z.array(z.string()).optional(),
    previewColors: z.array(z.string()).optional(),
    created_at: z.string().optional(),
    createdAt: z.string().optional(),
  })
  .passthrough()
  .transform((raw): DesignMdKitSummary => {
    const author =
      authorToString(raw.author) ||
      pickString(raw.author_username) ||
      '';
    const bareSlug = raw.slug.trim();
    // API list responses use bare kit slug; composite author/slug is what get/import need.
    const slug =
      bareSlug.includes('/')
        ? bareSlug
        : author
          ? `${author}/${bareSlug}`
          : bareSlug;
    const url =
      pickString(raw.url) ||
      (slug.includes('/') ? `https://designmd.ai/${slug}` : 'https://designmd.ai');
    return {
      slug,
      name: raw.name.trim(),
      description: typeof raw.description === 'string' ? raw.description : '',
      author,
      url,
      tags: Array.isArray(raw.tags) ? raw.tags : [],
      license: raw.license ?? 'unknown',
      downloadCount: pickNonNegativeInt(raw.downloadCount, raw.download_count),
      likeCount: pickNonNegativeInt(raw.likeCount, raw.like_count),
    };
  });

const kitDetailFieldsSchema = z
  .object({
    content: z.string().max(1024 * 1024).optional(),
    content_preview: z.string().max(1024 * 1024).optional(),
    contentPreview: z.string().max(1024 * 1024).optional(),
  })
  .passthrough();

export type DesignMdLicense = z.infer<typeof licenseSchema>;

export interface DesignMdKitSummary {
  slug: string;
  name: string;
  description: string;
  author: string;
  url: string;
  tags: string[];
  license: DesignMdLicense;
  downloadCount: number;
  likeCount: number;
}

export interface DesignMdKitDetail extends DesignMdKitSummary {
  content: string;
}

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

async function boundedBody(
  response: Response,
  maxBytes: number = DEFAULT_RESPONSE_BUDGET,
): Promise<string> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_RESPONSE_BUDGET) {
    throw new DesignMdApiError('invalid API response budget');
  }
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new DesignMdApiError('API response exceeds byte budget');
  }
  if (!response.body) return '';
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
  if (total === 0) return '';
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

async function boundedJson(
  response: Response,
  maxBytes: number = DEFAULT_RESPONSE_BUDGET,
): Promise<unknown> {
  const text = await boundedBody(response, maxBytes);
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new DesignMdApiError('API response is not valid JSON');
  }
}

async function apiRequest(
  path: string,
  init: RequestInit = {},
  deps: DesignMdApiDeps,
  {
    auth = false,
    maxBytes,
    accept = 'application/json',
    asText = false,
  }: {
    auth?: boolean;
    maxBytes?: number;
    accept?: string;
    asText?: boolean;
  } = {},
): Promise<unknown> {
  const headers = new Headers(init.headers);
  if (!headers.has('accept')) headers.set('accept', accept);
  if (init.body !== undefined && !headers.has('content-type')) {
    headers.set('content-type', 'application/json');
  }
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

  if (asText) {
    return boundedBody(response, maxBytes);
  }
  const contentType = response.headers.get('content-type') ?? '';
  if (contentType.includes('text/plain') || contentType.includes('text/markdown')) {
    return boundedBody(response, maxBytes);
  }
  return boundedJson(response, maxBytes);
}

function parseKitSummary(value: unknown): DesignMdKitSummary {
  return kitSummarySchema.parse(value);
}

function parseKitDetail(value: unknown, contentOverride?: string): DesignMdKitDetail {
  const summary = parseKitSummary(value);
  const fields = kitDetailFieldsSchema.parse(
    typeof value === 'object' && value !== null ? value : {},
  );
  const content =
    (typeof contentOverride === 'string' && contentOverride) ||
    (typeof fields.content === 'string' && fields.content) ||
    (typeof fields.content_preview === 'string' && fields.content_preview) ||
    (typeof fields.contentPreview === 'string' && fields.contentPreview) ||
    '';
  if (!content) {
    throw new DesignMdApiError('kit content missing from DesignMd API response');
  }
  if (content.length > 1024 * 1024) {
    throw new DesignMdApiError('kit content exceeds size limit');
  }
  return { ...summary, content };
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
  const tags: string[] = [];
  for (const item of list) {
    if (typeof item === 'string' && item.trim()) {
      tags.push(item.trim());
      continue;
    }
    if (item && typeof item === 'object') {
      const record = item as Record<string, unknown>;
      const name = pickString(record.slug, record.name);
      if (name) tags.push(name);
    }
  }
  return tags;
}

/** Parse `username/slug` or a full designmd.ai URL into path segments. */
export function parseKitIdentifier(identifier: string): { username: string; slug: string } {
  let cleaned = identifier.trim();
  if (!cleaned || cleaned.length > 512) {
    throw new DesignMdApiError('invalid kit identifier');
  }
  try {
    const url = new URL(cleaned);
    if (!/^(?:www\.)?designmd\.ai$/i.test(url.hostname)) {
      throw new DesignMdApiError('invalid kit identifier');
    }
    cleaned = url.pathname.replace(/^\/+/, '');
  } catch (error) {
    if (error instanceof DesignMdApiError) throw error;
    // not a URL — keep as-is
  }
  cleaned = cleaned.replace(/^\/+/, '').replace(/\/+$/, '');
  const parts = cleaned.split('/').filter(Boolean);
  if (parts.length !== 2 || parts.some((part) => part === '.' || part === '..')) {
    throw new DesignMdApiError('invalid kit identifier');
  }
  const [username, slug] = parts;
  if (!username || !slug || username.includes('//') || slug.includes('//')) {
    throw new DesignMdApiError('invalid kit identifier');
  }
  return { username, slug };
}

function kitPath(username: string, slug: string, suffix = ''): string {
  return `/kits/${encodeURIComponent(username)}/${encodeURIComponent(slug)}${suffix}`;
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
    // Official API expects a comma-separated `tags` query param (not repeated `tag=`).
    if (options.tags && options.tags.length > 0) {
      params.set('tags', options.tags.join(','));
    }
    if (options.sort) params.set('sort', options.sort);
    if (options.limit !== undefined) params.set('limit', String(options.limit));
    const query = params.toString();
    const path = query ? `/kits?${query}` : '/kits';
    const body = await apiRequest(path, {}, this.#deps, { maxBytes: LIST_RESPONSE_BUDGET });
    return parseKitList(body);
  }

  async listPopularKits(limit?: number): Promise<DesignMdKitSummary[]> {
    // `/kits/popular` is not a live route; popular kits are listed via sort.
    return this.searchKits({ sort: 'popular', ...(limit !== undefined ? { limit } : {}) });
  }

  async listTags(): Promise<string[]> {
    const body = await apiRequest('/tags', {}, this.#deps, { maxBytes: LIST_RESPONSE_BUDGET });
    return parseTagList(body);
  }

  async getKit(identifier: string): Promise<DesignMdKitDetail> {
    const { username, slug } = parseKitIdentifier(identifier);
    // Metadata is public; full DESIGN.md content requires auth via /raw
    // (matches official designmd CLI).
    const [metaBody, contentBody] = await Promise.all([
      apiRequest(kitPath(username, slug), {}, this.#deps, {
        maxBytes: LIST_RESPONSE_BUDGET,
      }),
      apiRequest(kitPath(username, slug, '/raw'), {}, this.#deps, {
        auth: true,
        maxBytes: 1024 * 1024,
        accept: 'text/plain, application/json',
        asText: true,
      }),
    ]);
    const content =
      typeof contentBody === 'string'
        ? contentBody
        : typeof contentBody === 'object' &&
            contentBody !== null &&
            'content' in contentBody &&
            typeof (contentBody as { content: unknown }).content === 'string'
          ? (contentBody as { content: string }).content
          : undefined;
    return parseKitDetail(metaBody, content);
  }

  async publishKit(input: {
    slug: string;
    name: string;
    description?: string;
    tags?: readonly string[];
    license?: string;
    content: string;
  }): Promise<DesignMdKitDetail> {
    const slug = input.slug.trim();
    if (!slug || slug.length > 512 || slug.includes('..') || slug.includes('//')) {
      throw new DesignMdApiError('invalid kit slug');
    }
    const name = input.name.trim();
    if (!name || name.length > 512) {
      throw new DesignMdApiError('invalid kit name');
    }
    if (!input.content || input.content.length > 1024 * 1024) {
      throw new DesignMdApiError('invalid kit content');
    }
    const body = await apiRequest(
      '/kits',
      {
        method: 'POST',
        body: JSON.stringify({
          slug,
          name,
          description: input.description ?? '',
          tags: input.tags ?? [],
          license: input.license ?? 'mit',
          content: input.content,
        }),
      },
      this.#deps,
      { auth: true, maxBytes: 1024 * 1024 },
    );
    return parseKitDetail(body, input.content);
  }
}
