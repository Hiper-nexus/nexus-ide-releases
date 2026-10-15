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
  /** The server refused this refresh for good: forget it, never present it again. */
  discardRejectedSession?: (refresh: string) => void;
  /** Main trace sink (main.trace.ndjson). Events never carry tokens. */
  trace?: (event: Record<string, unknown>) => void;
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
// The server consumes the refresh before it answers: giving up early leaves the app holding a spent token.
const REFRESH_TIMEOUT_MS = 30_000;
// One quick retry with the same token lands inside the server's 60 s retry window (REFRESH_REUSE_GRACE_MS).
const REFRESH_RETRY_DELAY_MS = 3_000;
const DEFAULT_RESPONSE_BUDGET = 256 * 1024;
const refreshFlights = new Map<string, Promise<string | null>>();

type RefreshOutcome = 'rotated' | 'timeout' | 'network' | 'rejected' | 'invalid-response' | 'superseded' | 'persist-failed';
interface RotatedPair {
  session: string;
  refresh: string;
  /** Stored refresh this pair replaces; the server already spent it. */
  replaced: string | null;
  previousSession: string | null;
  account: string | null | undefined;
  generation: number | undefined;
}
/**
 * Pairs the server handed over but the Keychain refused, by backend. The token
 * still on disk is spent: presenting it again looks like reuse, so the pair
 * here is presented instead until it persists. A login or logout that
 * replaces the stored pair drops it.
 */
const unsavedPairs = new Map<string, RotatedPair>();

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
    discardRejectedSession: (refresh) => auth.discardRejectedSession(refresh),
    trace: (event) => (require('./observability/main-trace') as typeof import('./observability/main-trace')).trace(event),
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

/** Refresh first: if the session write then fails, the next request can still recover with the valid token. */
function persistPair(deps: ApiDeps, pair: RotatedPair): boolean {
  return deps.setSecret('auth:refresh', pair.refresh).ok && deps.setSecret('auth:session', pair.session).ok;
}

/** The refresh to present: an unsaved rotated pair wins over the spent token still in the Keychain. */
function currentRefresh(deps: ApiDeps): string | null {
  const stored = deps.getSecret('auth:refresh');
  const pair = unsavedPairs.get(deps.backendUrl);
  if (!pair) return stored;
  if (pair.generation !== deps.generation?.() || (stored !== pair.replaced && stored !== pair.refresh)) {
    unsavedPairs.delete(deps.backendUrl);
    return stored;
  }
  if (persistPair(deps, pair)) {
    unsavedPairs.delete(deps.backendUrl);
    if (pair.account) deps.bindAccount?.(pair.account, pair.session, pair.previousSession ?? undefined);
  }
  return pair.refresh;
}

function failureOf(error: unknown): RefreshOutcome {
  if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) return 'timeout';
  if (error instanceof SyntaxError || (error instanceof Error && error.message.includes('byte budget'))) return 'invalid-response';
  return 'network';
}

interface RefreshResponse {
  status: number;
  body: unknown;
  started: number;
}
type RefreshReport = (outcome: RefreshOutcome, status: number, started: number) => void;

async function requestRefresh(deps: ApiDeps, refresh: string, started: number): Promise<RefreshResponse> {
  const res = await deps.fetchFn(urlFor(deps, '/v1/auth/refresh'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ refresh }),
    signal: AbortSignal.timeout(REFRESH_TIMEOUT_MS),
  });
  // The timeout also covers the body: a 200 whose body is lost is a lost rotation too.
  return { status: res.status, body: res.ok ? await boundedJson(res) : null, started };
}

/**
 * One request plus, after a timeout, a network error or a 5xx, one quick
 * retry with the SAME token: the server may have consumed it already, and its
 * retry window only answers a retry that arrives within 60 s.
 */
async function requestWithRetry(
  deps: ApiDeps,
  refresh: string,
  report: RefreshReport,
): Promise<RefreshResponse | null> {
  const stored = deps.getSecret('auth:refresh');
  const generation = deps.generation?.();
  for (let attempt = 0; ; attempt += 1) {
    const started = Date.now();
    try {
      const res = await requestRefresh(deps, refresh, started);
      if (res.status < 500 || attempt > 0) return res;
      report('rejected', res.status, started);
    } catch (error) {
      const outcome = failureOf(error);
      report(outcome, 0, started);
      if (outcome === 'invalid-response' || attempt > 0) return null;
    }
    await new Promise((resolve) => setTimeout(resolve, REFRESH_RETRY_DELAY_MS));
    // A logout or a new login during the wait owns the session now.
    if (deps.generation?.() !== generation || deps.getSecret('auth:refresh') !== stored) return null;
  }
}

async function performRefresh(
  deps: ApiDeps,
  refresh: string,
): Promise<string | null> {
  const stored = deps.getSecret('auth:refresh');
  const previousSession = deps.getSecret('auth:session');
  const account = deps.getAccountId?.();
  const generation = deps.generation?.();
  const report: RefreshReport = (outcome, status, started) => {
    deps.trace?.({ kind: 'auth-refresh', ok: outcome === 'rotated', status, durationMs: Date.now() - started, outcome });
  };
  const res = await requestWithRetry(deps, refresh, report);
  if (!res) return null;
  // A refused refresh is never presented again: a spent one past the server's
  // retry window revokes its whole family, signing this app out after a new
  // login. A login started during the request owns the session now:
  // discarding would cancel it. A refused unsaved pair takes its spent token along.
  if (res.status === 401 && deps.generation?.() === generation) {
    if (unsavedPairs.get(deps.backendUrl)?.refresh === refresh) unsavedPairs.delete(deps.backendUrl);
    deps.discardRejectedSession?.(stored ?? refresh);
  }
  if (res.status < 200 || res.status > 299) {
    report('rejected', res.status, res.started);
    return null;
  }
  const body = res.body as { ok?: boolean; data?: { session?: string; refresh?: string; licenca?: string } } | null;
  const session = body?.data?.session;
  const nextRefresh = body?.data?.refresh;
  if (!body?.ok || typeof session !== 'string' || !session || typeof nextRefresh !== 'string' || !nextRefresh) {
    report('invalid-response', res.status, res.started);
    return null;
  }
  if (deps.generation?.() !== generation || deps.getSecret('auth:session') !== previousSession || deps.getSecret('auth:refresh') !== stored) {
    report('superseded', res.status, res.started);
    return null;
  }
  const pair: RotatedPair = { session, refresh: nextRefresh, replaced: stored, previousSession, account, generation };
  unsavedPairs.delete(deps.backendUrl);
  if (!persistPair(deps, pair)) {
    // Never fall back to the spent token: this pair is presented until the Keychain takes it.
    unsavedPairs.set(deps.backendUrl, pair);
    report('persist-failed', res.status, res.started);
    return session;
  }
  report('rotated', res.status, res.started);
  if (account && deps.bindAccount && !deps.bindAccount(account, session, previousSession ?? undefined).ok) return null;
  if (typeof body.data?.licenca === 'string') deps.applyLicense?.(body.data.licenca);
  return session;
}

async function tryRefresh(deps: ApiDeps): Promise<string | null> {
  const refresh = currentRefresh(deps);
  if (!refresh) return null;
  const key = `${deps.backendUrl}:${createHash('sha256').update(refresh).digest('hex')}`;
  const active = refreshFlights.get(key);
  if (active) return active;
  let flight: Promise<string | null>;
  flight = performRefresh(deps, refresh).catch(() => null).finally(() => {
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
    // A body belongs to this login generation; never replay it under a new account.
    if (deps.generation?.() !== generation) return { status: 401, json: null };
    if (res.status === 401) {
      const current = deps.getSecret('auth:session');
      if (current && current !== session) {
        // Outro voo já renovou a sessão: repete UMA vez com ela em vez de
        // devolver um 401 espúrio.
        session = current;
        res = await doFetch(deps, path, init, current);
      } else {
        const renewed = await tryRefresh(deps);
        if (!renewed || deps.generation?.() !== generation) return { status: 401, json: null };
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
