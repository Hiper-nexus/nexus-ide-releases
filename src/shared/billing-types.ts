/**
 * Billing / license domain — the SaaS scaffold. Dependency-free (preload +
 * main + renderer all import it). The desktop app never talks to Stripe
 * directly: checkout/portal are brokered by the backend, and signed license
 * state lands here through the same authenticated API.
 */

// Fonte única do contrato app↔backend (o servidor importa os MESMOS tipos).
export type {
  CheckoutRequest,
  PlanId,
  LicenseInfo,
  TeamInfo,
  InviteInfo,
} from '../../shared/contract';
import type { LicenseInfo } from '../../shared/contract';
import { PRO_MONTHLY_PRICE, type PublicPlanId } from '../../shared/pricing';

export interface PlanDef {
  id: PublicPlanId;
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
    id: 'free',
    name: 'Free',
    priceMonthlyMinor: 0,
    currency: 'brl',
    tagline: 'Sem prazo e sem cartão',
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
      'Tudo do Free',
      'Failover multi-conta avançado',
      'Squads ilimitados na nuvem',
      'Sincronização entre máquinas',
      'Suporte prioritário',
    ],
  },
];

/**
 * Estado devolvido ao renderer em billing:get: os campos da licença mais se a
 * assinatura do token gravado foi REVERIFICADA na leitura. `verified: false`
 * (sem token gravado, sem NEXUS_LICENSE_PUBKEY ou assinatura inválida) não
 * bloqueia nada — só informa que o conteúdo do arquivo não tem prova criptográfica.
 */
export type LicenseState = LicenseInfo & { verified: boolean };

export const DEFAULT_LICENSE: LicenseInfo = {
  plan: 'free',
  email: null,
  status: 'none',
  renewsAt: null,
};

export const BILLING_CHANNELS = {
  get: 'billing:get',
  checkout: 'billing:checkout',
  portal: 'billing:portal',
  changed: 'billing:changed',
} as const;
