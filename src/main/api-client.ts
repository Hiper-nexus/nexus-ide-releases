import { createHash } from 'node:crypto';
import { resolveBackendUrl } from './backend-url';

export interface ApiDeps {
  backendUrl: string;
  fetchFn: typeof fetch;
  getSecret: (key: string) => string | null;
  applyLicense?: (jwt: string) => { ok: boolean; error?: string };
  getAccountId?: () => string | null;
  bindAccount?: (id: string, session: string, previousSession?: string) => { ok: boolean; error?: string };
  generation?: () => number;
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
  signal?: AbortSignal;
  /**
   * Política de redirecionamento do fetch. Sem valor, vale o padrão do fetch.
   * Envio de conteúdo do usuário (ex.: reporte de problema) passa `'error'`:
   * o destino é fixo, e um 3xx nunca deve levar o corpo a outro lugar.
   */
  redirect?: RequestRedirect;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_RESPONSE_BUDGET = 256 * 1024;
const refreshFlights = new Map<string, Promise<string | null>>();

function defaultDeps(): ApiDeps {
  // Lazy require: secrets-store importa electron/safeStorage indiretamente no app.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const secrets = require('./persistence/secrets-store') as typeof import('./persistence/secrets-store');
  const auth = require('./auth-client') as typeof import('./auth-client');
  return {
    applyLicense: (jwt) => (require('./license-access') as typeof import('./license-access')).applyOnlineLicenseToken(jwt),
    getAccountId: auth.getAuthenticatedAccountId,
    bindAccount: (id, session, previousSession) => auth.bindAuthenticatedAccount(id, session, undefined, previousSession),
    generation: auth.getAuthGeneration,
    backendUrl: resolveBackendUrl(),
    fetchFn: fetch,
    getSecret: (key) => secrets.getSecret(key),
    setSecret: (key, value) => secrets.setInternalSecret(key, value),
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
  const timeoutSignal = AbortSignal.timeout(
    init.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );
  const signal = init.signal
    ? AbortSignal.any([init.signal, timeoutSignal])
    : timeoutSignal;
  return deps.fetchFn(urlFor(deps, path), {
    method: init.method ?? 'GET',
    headers: {
      authorization: `Bearer ${session}`,
      ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    ...(init.redirect !== undefined ? { redirect: init.redirect } : {}),
    signal,
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
  const previousSession = deps.getSecret('auth:session');
  const account = deps.getAccountId?.();
  const generation = deps.generation?.();
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
      data?: { session?: string; refresh?: string; licenca?: string };
    };
    const session = body.data?.session;
    const nextRefresh = body.data?.refresh;
    if (!body.ok || typeof session !== 'string' || !session || typeof nextRefresh !== 'string' || !nextRefresh) return null;
    if (deps.generation?.() !== generation || deps.getSecret('auth:session') !== previousSession || deps.getSecret('auth:refresh') !== refresh) return null;
    // Persist the next single-use refresh first. If session persistence then
    // fails, the following request can still recover with the valid token.
    if (!deps.setSecret('auth:refresh', nextRefresh).ok) return null;
    if (!deps.setSecret('auth:session', session).ok) return null;
    if (account && deps.bindAccount && !deps.bindAccount(account, session, previousSession ?? undefined).ok) return null;
    if (typeof body.data?.licenca === 'string') deps.applyLicense?.(body.data.licenca);
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
  let session = deps.getSecret('auth:session');
  const generation = deps.generation?.();
  if (!session) return { status: 401, json: null };
  try {
    let res = await doFetch(deps, path, init, session);
    if (res.status === 401) {
      const current = deps.getSecret('auth:session');
      if (current && current !== session) {
        // Outro voo já renovou a sessão: repete UMA vez com ela em vez de
        // devolver um 401 espúrio.
        session = current;
        res = await doFetch(deps, path, init, current);
      } else {
        const renewed = await tryRefresh(deps);
        if (!renewed) return { status: 401, json: null };
        session = renewed;
        res = await doFetch(deps, path, init, renewed);
      }
    }
    const json = await boundedJson(res, init.maxResponseBytes ?? DEFAULT_RESPONSE_BUDGET);
    // F-228: logout/troca de conta (geração) invalida a resposta; rotação de
    // sessão por um voo irmão NÃO — a resposta 2xx já autorizada vale.
    if (deps.generation?.() !== generation) return { status: 401, json: null };
    return { status: res.status, json };
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
