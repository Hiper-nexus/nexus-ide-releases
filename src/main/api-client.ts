import { createHash } from 'node:crypto';

export interface ApiDeps {
  backendUrl: string;
  fetchFn: typeof fetch;
  getSecret: (key: string) => string | null;
  setSecret: (key: string, value: string) => { ok: boolean; error?: string };
}

export interface ApiResult {
  status: number;
  json: unknown;
}

export interface ApiRequestInit {
  method?: string;
  body?: unknown;
  timeoutMs?: number;
  maxResponseBytes?: number;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_RESPONSE_BUDGET = 256 * 1024;
const refreshFlights = new Map<string, Promise<string | null>>();

function defaultDeps(): ApiDeps {
  // Lazy require: secrets-store importa electron/safeStorage indiretamente no app.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const secrets = require('./persistence/secrets-store') as typeof import('./persistence/secrets-store');
  return {
    backendUrl: process.env.NEXUS_BACKEND_URL ?? 'https://api.nexuside.app',
    fetchFn: fetch,
    getSecret: (key) => secrets.getSecret(key),
    setSecret: (key, value) => secrets.setSecret(key, value),
  };
}

function urlFor(deps: ApiDeps, path: string): string {
  return `${deps.backendUrl.replace(/\/+$/, '')}${path.startsWith('/') ? path : `/${path}`}`;
}

async function doFetch(
  deps: ApiDeps,
  path: string,
  init: ApiRequestInit,
  session: string,
): Promise<Response> {
  return deps.fetchFn(urlFor(deps, path), {
    method: init.method ?? 'GET',
    headers: {
      authorization: `Bearer ${session}`,
      ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    signal: AbortSignal.timeout(init.timeoutMs ?? DEFAULT_TIMEOUT_MS),
  });
}

async function boundedJson(
  response: Response,
  maxBytes: number = DEFAULT_RESPONSE_BUDGET,
): Promise<unknown> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 1024 * 1024) {
    throw new Error('invalid API response budget');
  }
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new Error('API response exceeds byte budget');
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
        throw new Error('API response exceeds byte budget');
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
  return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
}

async function performRefresh(
  deps: ApiDeps,
  refresh: string,
): Promise<string | null> {
  try {
    const res = await deps.fetchFn(urlFor(deps, '/v1/auth/refresh'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ refresh }),
      signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const body = (await boundedJson(res)) as {
      ok?: boolean;
      data?: { session?: string; refresh?: string };
    };
    const session = body.data?.session;
    const nextRefresh = body.data?.refresh;
    if (!body.ok || !session || !nextRefresh) return null;
    // Persist the next single-use refresh first. If session persistence then
    // fails, the following request can still recover with the valid token.
    if (!deps.setSecret('auth:refresh', nextRefresh).ok) return null;
    if (!deps.setSecret('auth:session', session).ok) return null;
    return session;
  } catch {
    return null;
  }
}

async function tryRefresh(deps: ApiDeps): Promise<string | null> {
  const refresh = deps.getSecret('auth:refresh');
  if (!refresh) return null;
  const key = `${deps.backendUrl}:${createHash('sha256').update(refresh).digest('hex')}`;
  const active = refreshFlights.get(key);
  if (active) return active;
  let flight: Promise<string | null>;
  flight = performRefresh(deps, refresh).finally(() => {
    if (refreshFlights.get(key) === flight) refreshFlights.delete(key);
  });
  refreshFlights.set(key, flight);
  return flight;
}

export async function apiFetch(
  path: string,
  init: ApiRequestInit = {},
  deps: ApiDeps = defaultDeps(),
): Promise<ApiResult> {
  const session = deps.getSecret('auth:session');
  if (!session) return { status: 401, json: null };
  try {
    let res = await doFetch(deps, path, init, session);
    if (res.status === 401) {
      const renewed = await tryRefresh(deps);
      if (!renewed) return { status: 401, json: null };
      res = await doFetch(deps, path, init, renewed);
    }
    return {
      status: res.status,
      json: await boundedJson(
        res,
        init.maxResponseBytes ?? DEFAULT_RESPONSE_BUDGET,
      ),
    };
  } catch {
    return { status: 0, json: null };
  }
}

/** Same authenticated client against one explicit, already-policy-checked URL. */
export function apiFetchAt(
  backendUrl: string,
  path: string,
  init: ApiRequestInit = {},
): Promise<ApiResult> {
  return apiFetch(path, init, { ...defaultDeps(), backendUrl });
}
