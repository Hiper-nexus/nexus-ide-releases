/** Contrato compartilhado app↔backend. Fonte única — o app re-exporta daqui. */

export type PlanId = 'free' | 'pro' | 'team';

export interface LicenseInfo {
  plan: PlanId;
  email: string | null;
  status: 'none' | 'active' | 'past_due';
  renewsAt: string | null;
}

/** Payload assinado no JWT de licença (verificado offline pelo app). */
export interface LicensePayload {
  plan: PlanId;
  email: string | null;
  status: 'none' | 'active' | 'past_due';
  /** ISO — próxima renovação. */
  renewsAt: string | null;
  /** ISO — mantém o plano pago mesmo em past_due até aqui (grace). */
  graceUntil: string | null;
  /** epoch segundos — expiração do próprio token (TTL ~30d). */
  exp: number;
}

/** Evento de XP que o app sincroniza (Leaderboard, futuro). */
export interface XpSyncEvent {
  entityKey: string;
  kind: string;
  points: number;
  evidence: string | null;
  createdAt: number;
}
