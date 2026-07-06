/**
 * Billing / license domain — the SaaS scaffold. Dependency-free (preload +
 * main + renderer all import it). The desktop app never talks to Stripe
 * directly: checkout/portal are brokered by the backend, and signed license
 * state lands here through the same authenticated API.
 */

// Fonte única do contrato app↔backend (o servidor importa os MESMOS tipos).
export type { PlanId, LicenseInfo, TeamInfo, InviteInfo } from '../../shared/contract';
import type { LicenseInfo, PlanId } from '../../shared/contract';

export interface PlanDef {
  id: PlanId;
  name: string;
  /** Monthly price in USD; null = "fale conosco". */
  priceMonthly: number | null;
  tagline: string;
  features: string[];
}

/** The single source of plan copy (renderer renders straight from this). */
export const PLANS: PlanDef[] = [
  {
    id: 'free',
    name: 'Free',
    priceMonthly: 0,
    tagline: 'Para uso pessoal',
    features: [
      'Grid + canvas ilimitados',
      'Todas as CLIs locais',
      'Squads e missões',
      'Voz (suas próprias keys)',
    ],
  },
  {
    id: 'pro',
    name: 'Pro',
    priceMonthly: 19,
    tagline: 'Para quem opera todo dia',
    features: [
      'Tudo do Free',
      'Failover multi-conta avançado',
      'Squads ilimitados na nuvem',
      'Suporte prioritário',
    ],
  },
  {
    id: 'team',
    name: 'Team',
    priceMonthly: null,
    tagline: 'Squads compartilhados no time',
    features: [
      'Tudo do Pro',
      'Squads/playbooks compartilhados',
      'Billing centralizado',
      'Onboarding dedicado',
    ],
  },
];

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
