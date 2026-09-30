import { BrowserWindow, ipcMain, shell } from 'electron';
import {
  BILLING_CHANNELS,
  type CheckoutRequest,
  type LicenseState,
} from '../../shared/billing-types';
import { getAccessState, onAccessChanged } from '../license-access';
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
}

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
  };
}

function resolveBillingIpcDeps(overrides?: Partial<BillingIpcDeps>): BillingIpcDeps {
  if (overrides?.apiFetch && overrides.openExternal && overrides.startCheckoutPolling) {
    return overrides as BillingIpcDeps;
  }
  return { ...defaultBillingIpcDeps(), ...overrides };
}

export function registerBillingIpc(overrides?: Partial<BillingIpcDeps>): void {
  onAccessChanged(() => {
    for (const win of BrowserWindow.getAllWindows()) win.webContents.send(BILLING_CHANNELS.changed);
  });
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
}
