import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ipcMain, shell } from 'electron';
import {
  BILLING_CHANNELS,
  DEFAULT_LICENSE,
  type LicenseInfo,
  type PlanId,
} from '../../shared/billing-types';

/**
 * Billing scaffold — the desktop side of the future Stripe integration.
 *
 * Design (SaaS-ready, no secrets in the app):
 *  1. "Assinar" abre o navegador em BILLING_BASE/checkout?plan=X — o BACKEND
 *     cria a Stripe Checkout Session (nunca o app; a secret key jamais toca o
 *     desktop) e redireciona.
 *  2. O webhook do Stripe (checkout.session.completed / customer.subscription.*)
 *     emite uma licença assinada; o site devolve o usuário via deep link
 *     nexus://license/<token>, que o app valida e grava em ~/.nexus/license.json.
 *  3. "Gerenciar assinatura" abre o Stripe Customer Portal via BILLING_BASE.
 *
 * TODO(stripe): backend com /checkout, /portal e webhook; validação de
 * assinatura do token de licença; handler do deep link nexus://license.
 */

const LICENSE_FILE = path.join(os.homedir(), '.nexus', 'license.json');

/** Site de billing (backend Stripe). Trocar quando o SaaS for ao ar. */
const BILLING_BASE = 'https://nexuside.app/billing';

function readLicense(): LicenseInfo {
  try {
    const raw = JSON.parse(fs.readFileSync(LICENSE_FILE, 'utf8')) as Partial<LicenseInfo>;
    return {
      plan: raw.plan === 'pro' || raw.plan === 'team' ? raw.plan : 'free',
      email: typeof raw.email === 'string' ? raw.email : null,
      status:
        raw.status === 'active' || raw.status === 'past_due' ? raw.status : 'none',
      renewsAt: typeof raw.renewsAt === 'string' ? raw.renewsAt : null,
    };
  } catch {
    return DEFAULT_LICENSE;
  }
}

function writeLicense(info: LicenseInfo): void {
  fs.mkdirSync(path.dirname(LICENSE_FILE), { recursive: true });
  const tmp = `${LICENSE_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(info, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, LICENSE_FILE);
}

/**
 * Aplica um token de licença vindo do deep link nexus://license/<token>. O
 * token é um JWT `header.payload.signature` (base64url); sem a chave pública
 * do backend aqui, decodificamos o payload e gravamos o estado — a validação
 * de ASSINATURA fica pro backend/próxima fase (TODO stripe). Nunca lança.
 */
export function applyLicenseToken(
  token: string,
): { ok: boolean; error?: string } {
  const parts = token.split('.');
  if (parts.length < 2) return { ok: false, error: 'token malformado' };
  try {
    const payload = JSON.parse(
      Buffer.from(parts[1], 'base64url').toString('utf8'),
    ) as Partial<LicenseInfo>;
    writeLicense({
      plan: payload.plan === 'pro' || payload.plan === 'team' ? payload.plan : 'free',
      email: typeof payload.email === 'string' ? payload.email : null,
      status:
        payload.status === 'active' || payload.status === 'past_due'
          ? payload.status
          : 'active',
      renewsAt: typeof payload.renewsAt === 'string' ? payload.renewsAt : null,
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export function registerBillingIpc(): void {
  ipcMain.handle(BILLING_CHANNELS.get, (): LicenseInfo => readLicense());

  ipcMain.handle(BILLING_CHANNELS.checkout, (_e, raw: unknown) => {
    const plan: PlanId = raw === 'team' ? 'team' : 'pro';
    // O backend cria a Checkout Session e redireciona ao Stripe.
    void shell.openExternal(`${BILLING_BASE}/checkout?plan=${plan}`);
    return { ok: true };
  });

  ipcMain.handle(BILLING_CHANNELS.portal, () => {
    void shell.openExternal(`${BILLING_BASE}/portal`);
    return { ok: true };
  });
}
