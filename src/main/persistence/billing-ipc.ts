import { handleTrusted } from '../security/trusted-ipc';
import { logoutAuthSession } from '../auth-client';
import { ipcMain, shell } from 'electron';
import {
  BILLING_CHANNELS,
  type CheckoutRequest,
  type LicenseState,
} from '../../shared/billing-types';
import { applyOnlineLicenseToken, getAccessState } from '../license-access';
export { applyLicenseToken } from '../license-access';

/**
 * Billing desktop: o app nunca fala com Stripe direto. Checkout/portal passam
 * pelo backend autenticado; licença assinada é verificada e gravada localmente.
 */

/**
 * Hosts válidos para checkout/portal. O backend devolve a URL direta da sessão
 * Stripe (billing-routes retorna `session.url`), que vive em `*.stripe.com` —
 * só esse sufixo é legítimo. Não incluímos `.stripe.link`: sem um fluxo concreto
 * que o exija, cada sufixo extra é superfície de allowlist desnecessária.
 */
const BILLING_HOST_SUFFIXES = ['.stripe.com'];

function isAllowedBillingHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return BILLING_HOST_SUFFIXES.some(
    (suffix) => h === suffix.slice(1) || h.endsWith(suffix),
  );
}

/**
 * Mesma validação do handler WINDOW_CHANNELS.openExternal: só https:. Além do
 * protocolo, exige host do Stripe (checkout/portal). Impede que um backend
 * comprometido abra file://, javascript:, ou https://evil.example.
 */
function assertHttpsUrl(raw: string): string | null {
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:') return null;
    if (!isAllowedBillingHost(url.hostname)) return null;
    return url.toString();
  } catch {
    return null;
  }
}

interface BillingIpcDeps {
  apiFetch: (
    path: string,
    init?: { method?: string; body?: unknown },
  ) => Promise<{ status: number; json: unknown }>;
  openExternal: (url: string) => unknown;
  startCheckoutPolling: () => void;
  applyLicense: (jwt: string) => { ok: boolean; error?: string };
  /** A licença aplicada abre o app? (um token válido de uma concessão vencida não abre) */
  canUseApp?: () => boolean;
}

/** Mesmos limites do servidor (zod do /v1/license/redeem). */
const REDEEM_CODE_MIN = 4;
const REDEEM_CODE_MAX = 80;

export function currentPlan(): string { return getAccessState().plan; }

function normalizeCheckoutRequest(raw: unknown): CheckoutRequest | null {
  const req = (typeof raw === 'object' && raw !== null ? raw : { plan: raw }) as {
    plan?: unknown;
  };
  if (req.plan === 'pro') return { plan: 'pro' };
  return null;
}

function defaultBillingIpcDeps(): BillingIpcDeps {
  // Lazy require: mantém applyLicenseToken testável sem carregar o cliente HTTP.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { apiFetch } = require('../api-client') as typeof import('../api-client');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { startCheckoutPolling } = require('../license-sync') as typeof import('../license-sync');
  return {
    apiFetch,
    openExternal: (url) => shell.openExternal(url),
    startCheckoutPolling,
    applyLicense: applyOnlineLicenseToken,
  };
}

function resolveBillingIpcDeps(overrides?: Partial<BillingIpcDeps>): BillingIpcDeps {
  if (overrides?.apiFetch && overrides.openExternal && overrides.startCheckoutPolling && overrides.applyLicense) {
    return overrides as BillingIpcDeps;
  }
  return { ...defaultBillingIpcDeps(), ...overrides };
}

export function registerBillingIpc(overrides?: Partial<BillingIpcDeps>): void {
  handleTrusted(BILLING_CHANNELS.logout, () => logoutAuthSession());
  ipcMain.handle(BILLING_CHANNELS.get, (): LicenseState => getAccessState());

  ipcMain.handle(BILLING_CHANNELS.checkout, async (_e, raw: unknown) => {
    const req = normalizeCheckoutRequest(raw);
    if (!req) return { ok: false, error: 'plano inválido' };
    const deps = resolveBillingIpcDeps(overrides);
    const result = await deps.apiFetch('/v1/billing/checkout', {
      method: 'POST',
      body: req,
    });
    const body = result.json as { ok?: boolean; data?: { url?: string }; error?: string } | null;
    if (result.status !== 200 || !body?.data?.url) {
      return {
        ok: false,
        error: result.status === 401
          ? 'Sua sessão Nexus expirou — saia e entre de novo na conta'
          : body?.error ?? 'backend indisponível — tente de novo',
      };
    }
    const safeCheckoutUrl = assertHttpsUrl(body.data.url);
    if (!safeCheckoutUrl) {
      return { ok: false, error: 'URL de checkout inválida' };
    }
    void deps.openExternal(safeCheckoutUrl);
    deps.startCheckoutPolling();
    return { ok: true };
  });

  ipcMain.handle(BILLING_CHANNELS.portal, async () => {
    const deps = resolveBillingIpcDeps(overrides);
    const result = await deps.apiFetch('/v1/billing/portal', { method: 'POST' });
    const body = result.json as { ok?: boolean; data?: { url?: string }; error?: string } | null;
    if (result.status !== 200 || !body?.data?.url) {
      return {
        ok: false,
        error: result.status === 401
          ? 'Sua sessão Nexus expirou — saia e entre de novo na conta'
          : body?.error ?? 'backend indisponível',
      };
    }
    const safePortalUrl = assertHttpsUrl(body.data.url);
    if (!safePortalUrl) {
      return { ok: false, error: 'URL do portal inválida' };
    }
    void deps.openExternal(safePortalUrl);
    return { ok: true };
  });

  // "Tenho um código": o backend valida o código e devolve a licença assinada
  // já com o acesso liberado. Aplicar o token dispara billing:changed — a UI
  // destrava sozinha, sem polling.
  // handleTrusted: resgatar muda o estado da licença, então só a janela principal pode pedir
  // (mesma regra do logout) — um frame comprometido não força tentativas de código.
  handleTrusted(BILLING_CHANNELS.redeem, async (_e, raw: unknown) => {
    const code = typeof raw === 'string' ? raw.trim() : '';
    if (code.length < REDEEM_CODE_MIN || code.length > REDEEM_CODE_MAX) {
      return { ok: false, error: 'Código inválido.' };
    }
    const deps = resolveBillingIpcDeps(overrides);
    const result = await deps.apiFetch('/v1/license/redeem', {
      method: 'POST',
      body: { code },
    });
    const body = result.json as { ok?: boolean; data?: { licenca?: unknown }; error?: string } | null;
    const jwt = body?.ok ? body.data?.licenca : undefined;
    if (result.status !== 200 || typeof jwt !== 'string') {
      return {
        ok: false,
        error: result.status === 401
          ? 'Entre na sua conta Nexus para resgatar um código'
          : body?.error ?? 'Não consegui falar com o servidor. Tente de novo em instantes.',
      };
    }
    if (!deps.applyLicense(jwt).ok) {
      return { ok: false, error: 'A licença recebida não pôde ser validada. Tente novamente.' };
    }
    // Um token válido de uma concessão já encerrada não abre o app: nunca reportar sucesso nesse caso.
    const opensApp = deps.canUseApp ?? (() => getAccessState().canUseApp);
    if (!opensApp()) {
      return { ok: false, error: 'O código foi aceito, mas não liberou o acesso. Ele pode ter expirado.' };
    }
    return { ok: true };
  });
}
