import crypto from 'node:crypto';

/**
 * Cliente de auth do app. O login SÓ nasce aqui: beginLogin gera um nonce
 * local, abre o browser com ?app_state=<nonce> e deixa o login PENDENTE.
 * O deep link nexus://auth/<code>?state=<nonce> só é aceito se o state
 * casar com o pendente (anti login-CSRF/session fixation) — deep link sem
 * login pendente é descartado. Deps injetáveis p/ teste; a borda default
 * usa electron shell, secrets-store e billing-ipc.
 */

const PENDING_TTL_MS = 10 * 60 * 1000;

interface PendingLogin {
  nonce: string;
  expiresAt: number;
}

let pending: PendingLogin | null = null;

/** Só para testes e logout: descarta o login pendente. */
export function resetPendingLogin(): void {
  pending = null;
}

export interface AuthDeps {
  backendUrl: string;
  fetchFn: typeof fetch;
  setSecret: (key: string, value: string) => { ok: boolean; error?: string };
  applyLicense: (jwt: string) => { ok: boolean; error?: string };
  openExternal: (url: string) => void;
  now?: () => number;
}

function defaultDeps(): AuthDeps {
  // Lazy require: estes módulos importam electron; manter fora do topo
  // preserva este módulo testável sem electron (padrão do repo).
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const secrets = require('./persistence/secrets-store') as typeof import('./persistence/secrets-store');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const billing = require('./persistence/billing-ipc') as typeof import('./persistence/billing-ipc');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { shell } = require('electron') as typeof import('electron');
  return {
    backendUrl: process.env.NEXUS_BACKEND_URL ?? 'https://api.nexuside.app',
    fetchFn: fetch,
    setSecret: (k, v) => secrets.setSecret(k, v),
    applyLicense: (jwt) => billing.applyLicenseToken(jwt),
    openExternal: (url) => void shell.openExternal(url),
  };
}

export type LoginProvider = 'github' | 'google';

export function beginLogin(
  provider: LoginProvider,
  deps: AuthDeps = defaultDeps(),
): { ok: boolean } {
  const now = deps.now ?? Date.now;
  const nonce = crypto.randomBytes(24).toString('base64url');
  pending = { nonce, expiresAt: now() + PENDING_TTL_MS };
  deps.openExternal(
    `${deps.backendUrl}/v1/auth/${provider}?app_state=${nonce}`,
  );
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
  pending = null; // nonce é single-use: consome ANTES da rede (anti-replay)

  try {
    const res = await deps.fetchFn(`${deps.backendUrl}/v1/auth/exchange`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code }),
    });
    if (!res.ok) return { ok: false, error: `exchange HTTP ${res.status}` };
    const json = (await res.json()) as {
      ok: boolean;
      data?: { session: string; refresh: string; licenca: string };
    };
    if (!json.ok || !json.data) return { ok: false, error: 'resposta inválida' };
    // Falha FECHADO: se qualquer persistência falhar, o login não "parece"
    // ter dado certo com sessão/licença ausentes.
    const s1 = deps.setSecret('auth:session', json.data.session);
    if (!s1.ok) return { ok: false, error: `sessão não persistida: ${s1.error}` };
    const s2 = deps.setSecret('auth:refresh', json.data.refresh);
    if (!s2.ok) return { ok: false, error: `refresh não persistido: ${s2.error}` };
    const lic = deps.applyLicense(json.data.licenca);
    if (!lic.ok) return { ok: false, error: `licença não aplicada: ${lic.error}` };
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
