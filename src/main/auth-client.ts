/**
 * Cliente de auth do app: troca o code do deep-link nexus://auth por
 * session/refresh (guardados no Keychain) + licença (aplicada offline). Deps
 * injetáveis p/ teste; a borda default usa secrets-store e billing-ipc.
 */

export interface ExchangeDeps {
  backendUrl: string;
  fetchFn: typeof fetch;
  setSecret: (key: string, value: string) => { ok: boolean; error?: string };
  applyLicense: (jwt: string) => { ok: boolean; error?: string };
}

function defaultDeps(): ExchangeDeps {
  // Lazy require: secrets-store/billing-ipc importam electron; manter fora do
  // topo preserva este módulo testável sem electron (padrão do repo).
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const secrets = require('./persistence/secrets-store') as typeof import('./persistence/secrets-store');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const billing = require('./persistence/billing-ipc') as typeof import('./persistence/billing-ipc');
  return {
    backendUrl: process.env.NEXUS_BACKEND_URL ?? 'https://api.nexuside.app',
    fetchFn: fetch,
    setSecret: (k, v) => secrets.setSecret(k, v),
    applyLicense: (jwt) => billing.applyLicenseToken(jwt),
  };
}

export async function exchangeAuthCode(
  code: string,
  deps: ExchangeDeps = defaultDeps(),
): Promise<{ ok: boolean; error?: string }> {
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
    deps.setSecret('auth:session', json.data.session);
    deps.setSecret('auth:refresh', json.data.refresh);
    deps.applyLicense(json.data.licenca);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
