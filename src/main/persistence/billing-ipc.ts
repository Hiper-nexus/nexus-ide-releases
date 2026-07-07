import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ipcMain, shell } from 'electron';
import {
  BILLING_CHANNELS,
  DEFAULT_LICENSE,
  type CheckoutRequest,
  type LicenseInfo,
  type LicenseState,
} from '../../shared/billing-types';

/**
 * Billing desktop: o app nunca fala com Stripe direto. Checkout/portal passam
 * pelo backend autenticado; licença assinada é verificada e gravada localmente.
 */

const LICENSE_FILE = path.join(os.homedir(), '.nexus', 'license.json');

interface BillingIpcDeps {
  apiFetch: (
    path: string,
    init?: { method?: string; body?: unknown },
  ) => Promise<{ status: number; json: unknown }>;
  openExternal: (url: string) => unknown;
  startCheckoutPolling: () => void;
}

function readLicense(): LicenseState {
  try {
    const raw = JSON.parse(fs.readFileSync(LICENSE_FILE, 'utf8')) as Partial<LicenseInfo> & {
      token?: unknown;
    };
    return {
      plan: raw.plan === 'pro' || raw.plan === 'team' ? raw.plan : 'free',
      email: typeof raw.email === 'string' ? raw.email : null,
      status:
        raw.status === 'active' || raw.status === 'past_due' ? raw.status : 'none',
      renewsAt: typeof raw.renewsAt === 'string' ? raw.renewsAt : null,
      // O arquivo é gravável pelo usuário — reverifica a assinatura do token
      // gravado a cada leitura; sem token/chave, o estado é "não provado".
      verified: verifyStoredToken(raw.token),
    };
  } catch {
    return { ...DEFAULT_LICENSE, verified: false };
  }
}

/**
 * Reverifica o JWT gravado junto da licença (assinatura + expiração) contra a
 * chave pública pinada. Licenças antigas (sem token gravado) ou builds sem
 * NEXUS_LICENSE_PUBKEY resultam em false — nunca lança.
 */
function verifyStoredToken(token: unknown): boolean {
  if (typeof token !== 'string') return false;
  const publicKeyPem = licensePublicKey();
  if (!publicKeyPem) return false;
  const parts = token.split('.');
  if (parts.length !== 3) return false;
  let alg = '';
  try {
    const header = JSON.parse(
      Buffer.from(parts[0], 'base64url').toString('utf8'),
    ) as { alg?: string };
    alg = typeof header.alg === 'string' ? header.alg : '';
  } catch {
    return false;
  }
  if (!verifyJwtSignature(parts[0], parts[1], parts[2], publicKeyPem, alg)) {
    return false;
  }
  try {
    const payload = JSON.parse(
      Buffer.from(parts[1], 'base64url').toString('utf8'),
    ) as { exp?: number };
    return !(typeof payload.exp === 'number' && payload.exp * 1000 < Date.now());
  } catch {
    return false;
  }
}

export function currentPlan(): string {
  return readLicense().plan;
}

function normalizeCheckoutRequest(raw: unknown): CheckoutRequest | null {
  const req = (typeof raw === 'object' && raw !== null ? raw : { plan: raw }) as {
    plan?: unknown;
    seats?: unknown;
    teamName?: unknown;
  };
  if (req.plan === 'pro') return { plan: 'pro' };
  if (req.plan !== 'team') return null;
  return {
    plan: 'team',
    seats: typeof req.seats === 'number' && Number.isFinite(req.seats)
      ? req.seats
      : undefined,
    teamName: typeof req.teamName === 'string' ? req.teamName : undefined,
  };
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

function writeLicense(
  info: LicenseInfo & { token?: string },
  file: string = LICENSE_FILE,
): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(info, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/**
 * Chave pública PINADA de verificação de licença (SPKI PEM), do backend de
 * billing. Fornecida por env no build/runtime; SEM ela, nenhum token de
 * licença é aceito — um token não verificado NUNCA eleva o plano.
 */
function licensePublicKey(): string | null {
  const pem = process.env.NEXUS_LICENSE_PUBKEY?.trim();
  return pem && pem.includes('BEGIN PUBLIC KEY') ? pem : null;
}

/** Verifica a assinatura JWT (EdDSA/Ed25519 ou RS256) sobre header.payload. */
function verifyJwtSignature(
  headerB64: string,
  payloadB64: string,
  signatureB64: string,
  publicKeyPem: string,
  alg: string,
): boolean {
  try {
    const signingInput = Buffer.from(`${headerB64}.${payloadB64}`);
    const signature = Buffer.from(signatureB64, 'base64url');
    const key = crypto.createPublicKey(publicKeyPem);
    if (alg === 'EdDSA') {
      return crypto.verify(null, signingInput, key, signature);
    }
    if (alg === 'RS256') {
      return crypto.verify('sha256', signingInput, key, signature);
    }
    return false; // algoritmo não suportado — recusa (nunca 'none')
  } catch {
    return false;
  }
}

/**
 * Aplica um token de licença vindo do deep link nexus://license/<token>. O
 * token é um JWT `header.payload.signature`; a ASSINATURA é VERIFICADA contra
 * a chave pública pinada (SEGURANÇA: sem verificação, um deep link forjado
 * daria plano pago de graça). Sem chave configurada, recusa. Nunca lança.
 * `opts.publicKeyPem` existe só para testes.
 */
export function applyLicenseToken(
  token: string,
  opts: { publicKeyPem?: string; licensePath?: string } = {},
): { ok: boolean; error?: string } {
  const parts = token.split('.');
  if (parts.length !== 3) return { ok: false, error: 'token malformado' };
  const publicKeyPem = opts.publicKeyPem ?? licensePublicKey();
  if (!publicKeyPem) {
    return {
      ok: false,
      error:
        'sem chave de verificação de licença (NEXUS_LICENSE_PUBKEY) — token ' +
        'recusado para não elevar plano sem prova de assinatura.',
    };
  }
  let alg = '';
  try {
    const header = JSON.parse(
      Buffer.from(parts[0], 'base64url').toString('utf8'),
    ) as { alg?: string };
    alg = typeof header.alg === 'string' ? header.alg : '';
  } catch {
    return { ok: false, error: 'header do token inválido' };
  }
  if (!verifyJwtSignature(parts[0], parts[1], parts[2], publicKeyPem, alg)) {
    return { ok: false, error: 'assinatura de licença inválida' };
  }
  try {
    const payload = JSON.parse(
      Buffer.from(parts[1], 'base64url').toString('utf8'),
    ) as Partial<LicenseInfo> & { exp?: number };
    // Expiração (se presente): token vencido não vale.
    if (typeof payload.exp === 'number' && payload.exp * 1000 < Date.now()) {
      return { ok: false, error: 'licença expirada' };
    }
    writeLicense(
      {
        plan: payload.plan === 'pro' || payload.plan === 'team' ? payload.plan : 'free',
        email: typeof payload.email === 'string' ? payload.email : null,
        status:
          payload.status === 'active' || payload.status === 'past_due'
            ? payload.status
            : 'active',
        renewsAt: typeof payload.renewsAt === 'string' ? payload.renewsAt : null,
        // Guarda o JWT junto: permite reverificar a assinatura em cada leitura
        // (ver verifyStoredToken) em vez de confiar no JSON cru do disco.
        token,
      },
      opts.licensePath,
    );
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export function registerBillingIpc(overrides?: Partial<BillingIpcDeps>): void {
  ipcMain.handle(BILLING_CHANNELS.get, (): LicenseState => readLicense());

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
          ? 'entre na sua conta primeiro'
          : body?.error ?? 'backend indisponível — tente de novo',
      };
    }
    void deps.openExternal(body.data.url);
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
          ? 'entre na sua conta primeiro'
          : body?.error ?? 'backend indisponível',
      };
    }
    void deps.openExternal(body.data.url);
    return { ok: true };
  });
}
