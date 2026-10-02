import crypto from 'node:crypto';
import { resolveBackendUrl } from './backend-url';
import { verifyLicenseToken } from './persistence/billing-license';
import type { apiFetch } from './api-client';
import {
  LOGIN_PENDING_TTL_MS,
  loginExchangeMessage,
  loginProbeMessage,
  type LoginProbeFailure,
  type LoginProvider,
} from '../shared/auth-login';

import { bindLicenseAccount, readLicenseAccountState, LICENSE_SEAL_KEY, type LicenseAccountStore as IdentityStore } from './license-account-state';

/**
 * Cliente de auth do app. O login SÓ nasce aqui: beginLogin gera um nonce
 * local, abre o browser com ?app_state=<nonce> e deixa o login PENDENTE.
 * O deep link nexus://auth/<code>?state=<nonce> só é aceito se o state
 * casar com o pendente (anti login-CSRF/session fixation) — deep link sem
 * login pendente é descartado. Deps injetáveis p/ teste; a borda default
 * usa electron shell, secrets-store e billing-ipc.
 */

const PENDING_TTL_MS = LOGIN_PENDING_TTL_MS;
const PROBE_TIMEOUT_MS = 8000;

interface PendingLogin {
  nonce: string;
  expiresAt: number;
  /** PKCE verifier for the auth-code exchange (M11). */
  codeVerifier: string;
}

let pending: PendingLogin | null = null;
let authGeneration = 0;
/** Último login iniciado: a sonda de um clique antigo não pode vencer o mais novo. */
let beginSequence = 0;
export function getAuthGeneration(): number { return authGeneration; }

function secretStore() { return require('./persistence/secrets-store') as typeof import('./persistence/secrets-store'); }

/** Cached-only: never unlock the Keychain on a permission query or first paint. */
export function getAuthenticatedAccountId(store: IdentityStore = secretStore()): string | null {
  return readLicenseAccountState(store)?.id ?? null;
}

export function bindAuthenticatedAccount(id: string, session: string, store: IdentityStore = secretStore(), previousSession?: string): { ok: boolean; error?: string } {
  return bindLicenseAccount(id, session, store, previousSession);
}

/** Only call after first paint or an explicit login gesture. Older installs need /me online once. */
export async function restoreAuthenticatedAccount(deps?: { store: IdentityStore; api: typeof apiFetch }): Promise<void> {
  const store = deps?.store ?? secretStore();
  const session = store.getSecret('auth:session');
  store.getSecret('auth:account');
  store.getSecret(LICENSE_SEAL_KEY);
  if (!session || getAuthenticatedAccountId(store)) return;
  const generation = authGeneration;
  const api = deps?.api ?? (require('./api-client') as typeof import('./api-client')).apiFetch;
  const result = await api('/v1/me');
  const body = result.json as { ok?: boolean; data?: { id?: unknown } } | null;
  const current = store.getSecret('auth:session');
  if (generation !== authGeneration || !current || result.status !== 200 || !body?.ok || typeof body.data?.id !== 'string' || !body.data.id.trim()) return;
  bindAuthenticatedAccount(body.data.id, current, store);
}


/** Só para testes e logout: descarta o login pendente. */
export function resetPendingLogin(): void {
  pending = null;
  authGeneration += 1;
}

export interface AuthDeps {
  backendUrl: string;
  fetchFn: typeof fetch;
  setSecret: (key: string, value: string) => { ok: boolean; error?: string };
  validateLicense: (jwt: string, accountId: string) => { ok: boolean; error?: string };
  bindAccount: (id: string, session: string) => { ok: boolean; error?: string };
  clearAccess: () => void;
  applyLicense: (jwt: string) => { ok: boolean; error?: string };
  openExternal: (url: string) => void;
  /**
   * Checagem prévia do início do login. `null` = pode abrir o navegador; senão
   * o motivo definitivo. Ausente (testes) = sem checagem.
   */
  probeLogin?: (url: string) => Promise<LoginProbeFailure | null>;
  now?: () => number;
}

function defaultDeps(): AuthDeps {
  // Lazy require: estes módulos importam electron; manter fora do topo
  // preserva este módulo testável sem electron (padrão do repo).
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const secrets = require('./persistence/secrets-store') as typeof import('./persistence/secrets-store');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const access = require('./license-access') as typeof import('./license-access');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { shell } = require('electron') as typeof import('electron');
  return {
    backendUrl: resolveBackendUrl(),
    fetchFn: fetch,
    setSecret: (k, v) => secrets.setInternalSecret(k, v),
    validateLicense: (jwt, accountId) => {
      const result = verifyLicenseToken(jwt, {
        publicKeyPem: process.env.NEXUS_LICENSE_PUBKEY?.trim() || null,
        issuer: new URL(resolveBackendUrl()).origin, now: Date.now,
      });
      if (!result.ok) return { ok: false, error: result.reason };
      return result.claims.sub === accountId ? { ok: true } : { ok: false, error: 'account-mismatch' };
    },
    bindAccount: bindAuthenticatedAccount,
    clearAccess: () => (require('./license-access') as typeof import('./license-access')).clearAccess(),
    applyLicense: (jwt) => access.applyOnlineLicenseToken(jwt),
    openExternal: (url) => void shell.openExternal(url),
    probeLogin: (url) => probeLoginEndpoint(url, fetch),
  };
}

export type { LoginProvider };

/**
 * Pergunta ao servidor se o login pode começar ANTES de abrir o navegador.
 * Sem isso, um backend sem o provedor configurado (503) vira uma aba com JSON
 * cru e o app esperando um deep link que nunca chega. O redirecionamento NÃO é
 * seguido: 3xx é o caminho feliz. 2xx também não bloqueia (o navegador decide);
 * só falha definitiva (4xx/5xx) ou rede caída impede a abertura. Nunca devolve
 * o texto da exceção nem do corpo — só o status.
 */
export async function probeLoginEndpoint(
  url: string,
  fetchFn: typeof fetch,
): Promise<LoginProbeFailure | null> {
  try {
    const res = await fetchFn(url, {
      redirect: 'manual',
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    // O corpo (JSON de erro) não interessa: solta o socket em vez de deixá-lo preso.
    void res.body?.cancel().catch(() => {});
    return res.status >= 400 ? { status: res.status } : null;
  } catch (error) {
    // Servidor frio/lento não é servidor recusando: deixa o navegador tentar,
    // como antes da checagem. Só falha rápida de rede (DNS, recusa) bloqueia.
    if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) return null;
    return { network: true };
  }
}

export type BeginLoginResult = { ok: true } | { ok: false; error: string };

export async function beginLogin(
  provider: LoginProvider,
  deps: AuthDeps = defaultDeps(),
): Promise<BeginLoginResult> {
  const now = deps.now ?? Date.now;
  const nonce = crypto.randomBytes(24).toString('base64url');
  // M11: generate a PKCE pair so the auth-code exchange is bound to THIS
  // desktop instance — a malicious app intercepting the deep-link code cannot
  // exchange it without the verifier that never leaves this process.
  const codeVerifier = crypto.randomBytes(32).toString('base64url');
  const codeChallenge = crypto
    .createHash('sha256')
    .update(codeVerifier)
    .digest('base64url');
  const params = new URLSearchParams({ app_state: nonce, code_challenge: codeChallenge });
  const url = `${deps.backendUrl}/v1/auth/${provider}?${params.toString()}`;
  // O login pendente só nasce DEPOIS da checagem: uma tentativa que o servidor
  // recusa não pode derrubar o login anterior que ainda estava em curso.
  const attempt = ++beginSequence;
  const generationBefore = authGeneration;
  const failure = deps.probeLogin ? await deps.probeLogin(url) : null;
  // Outro clique veio depois, ou houve logout/reset durante a sonda: este login
  // não pode mais abrir o navegador nem virar o pendente.
  if (attempt !== beginSequence || generationBefore !== authGeneration) {
    return { ok: false, error: loginExchangeMessage('login superseded') };
  }
  if (failure) return { ok: false, error: loginProbeMessage(provider, failure) };
  authGeneration += 1;
  pending = { nonce, expiresAt: now() + PENDING_TTL_MS, codeVerifier };
  deps.openExternal(url);
  return { ok: true };
}

export async function exchangeAuthCode(
  code: string,
  state: string | null,
  deps: AuthDeps = defaultDeps(),
): Promise<{ ok: boolean; error?: string }> {
  const now = deps.now ?? Date.now;
  // Binding local: sem login pendente (ou expirado), o deep link pode ter
  // vindo de qualquer site — descarta antes de tocar a rede.
  if (!pending || pending.expiresAt < now()) {
    pending = null;
    return { ok: false, error: 'nenhum login pendente' };
  }
  if (!state || state !== pending.nonce) {
    return { ok: false, error: 'state não confere com o login pendente' };
  }
  const generation = authGeneration;
  const codeVerifier = pending.codeVerifier;
  const attempt = beginSequence;
  const superseded = (): boolean => generation !== authGeneration;
  // Rejected probes do not revoke accepted storage authority; older failures
  // still cannot replace the UI of a newer probe currently opening.
  const reject = (reason: string): { ok: false; error: string } => ({ ok: false,
    error: superseded() || attempt !== beginSequence ? 'login superseded' : reason });
  pending = null; // nonce é single-use: consome ANTES da rede (anti-replay)

  let failure = 'exchange-network';
  try {
    const res = await deps.fetchFn(`${deps.backendUrl}/v1/auth/exchange`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code, code_verifier: codeVerifier }),
      signal: AbortSignal.timeout(10000),
    });
    if (superseded()) return { ok: false, error: 'login superseded' };
    if (!res.ok) return reject('exchange-http');
    failure = 'exchange-invalid-response';
    const json = (await res.json()) as {
      ok: boolean;
      data?: { session: string; refresh: string; licenca: string };
    };
    if (superseded()) return { ok: false, error: 'login superseded' };
    if (!json.ok || !json.data || !['session', 'refresh', 'licenca'].every(key => typeof json.data?.[key as keyof typeof json.data] === 'string' && json.data[key as keyof typeof json.data])) return reject('exchange-invalid-response');
    // A signed license does not prove which account owns this opaque session.
    failure = 'exchange-network';
    const profileResponse = await deps.fetchFn(`${deps.backendUrl}/v1/me`, {
      headers: { authorization: `Bearer ${json.data.session}` }, signal: AbortSignal.timeout(10000),
    });
    if (superseded()) return { ok: false, error: 'login superseded' };
    failure = 'exchange-invalid-response';
    const profile = await profileResponse.json() as { ok?: boolean; data?: { id?: unknown } };
    if (superseded()) return { ok: false, error: 'login superseded' };
    if (!profileResponse.ok || !profile.ok || typeof profile.data?.id !== 'string' || !profile.data.id.trim()) return reject('account identity unavailable');
    const proof = deps.validateLicense(json.data.licenca, profile.data.id);
    if (!proof.ok) return reject('exchange-license-invalid');
    failure = 'exchange-storage';
    deps.clearAccess();
    // Falha FECHADO: se qualquer persistência falhar, o login não "parece"
    // ter dado certo com sessão/licença ausentes.
    const s1 = deps.setSecret('auth:session', json.data.session);
    if (!s1.ok) return reject('exchange-storage');
    const s2 = deps.setSecret('auth:refresh', json.data.refresh);
    if (!s2.ok) return reject('exchange-storage');
    const binding = deps.bindAccount(profile.data.id, json.data.session);
    if (!binding.ok) return reject('exchange-storage');
    failure = 'exchange-license-invalid';
    const lic = deps.applyLicense(json.data.licenca);
    if (!lic.ok) return reject('exchange-license-invalid');
    return { ok: true };
  } catch {
    return reject(failure);
  }
}

export interface LogoutDeps {
  backendUrl: string;
  getSecret: (key: string) => string | null;
  deleteSecret: (key: string) => { ok: boolean; error?: string };
  clearAccess: () => void;
  fetchFn: typeof fetch;
}
function defaultLogoutDeps(): LogoutDeps {
  return { backendUrl: resolveBackendUrl(), getSecret: key => secretStore().getSecret(key),
    deleteSecret: key => secretStore().deleteInternalSecret(key), fetchFn: fetch,
    clearAccess: () => (require('./license-access') as typeof import('./license-access')).clearAccess() };
}
/** Main-owned logout. Revocation comes first; existing processes and project data are untouched. */
export async function logoutAuthSession(deps: LogoutDeps = defaultLogoutDeps()): Promise<{ ok: boolean; error?: string }> {
  deps.clearAccess();
  const session = deps.getSecret('auth:session');
  const removedSession = deps.deleteSecret('auth:session');
  const removedRefresh = deps.deleteSecret('auth:refresh');
  if (session) {
    try {
      await deps.fetchFn(`${deps.backendUrl}/v1/auth/logout`, {
        method: 'POST', headers: { authorization: `Bearer ${session}` }, signal: AbortSignal.timeout(10000),
      });
    } catch { /* Local logout remains effective offline. */ }
  }
  return removedSession.ok && removedRefresh.ok ? { ok: true } : { ok: false, error: 'Não foi possível remover as credenciais salvas. O acesso permanece bloqueado.' };
}
