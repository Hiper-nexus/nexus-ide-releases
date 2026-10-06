/**
 * Billing / license domain — the SaaS scaffold. Dependency-free (preload +
 * main + renderer all import it). The desktop app never talks to Stripe
 * directly: checkout/portal are brokered by the backend, and signed license
 * state lands here through the same authenticated API.
 */

// Fonte única do contrato app↔backend (o servidor importa os MESMOS tipos).
export type {
  CheckoutInterval,
  CheckoutRequest,
  PlanId,
  LicenseInfo,
  TeamInfo,
  InviteInfo,
} from '../../shared/contract';
export { PRO_INTERVAL_PRICES } from '../../shared/pricing';
import type { LicenseAccess, LicenseLimits, LicenseInfo } from '../../shared/contract';
import { PRO_MONTHLY_PRICE } from '../../shared/pricing';

export interface PlanDef {
  id: 'trial' | 'pro';
  name: string;
  priceMonthlyMinor: number;
  currency: 'brl';
  promotionLabel?: string;
  tagline: string;
  features: string[];
}

/** The single source of plan copy (renderer renders straight from this). */
export const PLANS: PlanDef[] = [
  {
    id: 'trial',
    name: 'Teste de 15 dias',
    priceMonthlyMinor: 0,
    currency: 'brl',
    tagline: 'A partir do primeiro login verificado',
    features: [
      'Terminal e editor locais',
      'Todas as CLIs instaladas na máquina',
      'Projetos e missões salvos localmente',
      'Use suas próprias contas e chaves',
    ],
  },
  {
    id: 'pro',
    name: 'Pro',
    priceMonthlyMinor: PRO_MONTHLY_PRICE.unitAmount,
    currency: PRO_MONTHLY_PRICE.currency,
    promotionLabel: 'Preço promocional',
    tagline: 'Para quem opera todo dia',
    features: [
      'Acesso após o período de teste',
      'Agentes simultâneos ilimitados',
      'Failover multi-conta avançado',
      'Squads na nuvem',
      'Sincronização entre máquinas',
      'Suporte prioritário',
    ],
  },
];

export type AccessBlockedReason =
  | 'startup-pending'
  | 'login-required' | 'verification-unavailable' | 'invalid-license'
  | 'account-mismatch' | 'license-expired' | 'trial-ended' | 'suspended' | 'inactive';

/** Main-owned projection of a token verified on this query. Never a permission input. */
export type LicenseState = LicenseInfo & {
  verified: boolean;
  access: LicenseAccess | null;
  trialEndsAt: string | null;
  limits: LicenseLimits;
  expiresAt: string | null;
  canUseApp: boolean;
  blockedReason: AccessBlockedReason | null;
};

export const DEFAULT_LICENSE: LicenseState = {
  plan: 'free', email: null, status: 'none', renewsAt: null,
  verified: false, access: null, trialEndsAt: null,
  limits: { maxAgents: 0, cloudSync: false }, expiresAt: null,
  canUseApp: false, blockedReason: 'login-required',
};

export const BILLING_CHANNELS = {
  get: 'billing:get', logout: 'billing:logout', checkout: 'billing:checkout', portal: 'billing:portal', redeem: 'billing:redeem', changed: 'billing:changed',
} as const;
