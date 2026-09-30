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

/** Desktop v2: legacy LicensePayload above is only for the retired server workspace. */
export type LicenseAccess = 'trial' | 'pro' | 'suspended' | 'inactive';
export interface LicenseLimits { maxAgents: number | null; cloudSync: boolean; }
export interface DesktopLicenseClaims extends LicensePayload {
  sub: string;
  iss: string;
  aud: 'nexus-desktop';
  iat: number;
  nbf?: number;
  access: LicenseAccess;
  trialEndsAt: string | null;
  limits: LicenseLimits;
}
export const LICENSE_MAX_TTL_SECONDS = 24 * 60 * 60;
export const LICENSE_BLOCKED_TTL_SECONDS = 5 * 60;

/** Evento de XP que o app sincroniza (Leaderboard, futuro). */
export interface XpSyncEvent {
  entityKey: string;
  kind: string;
  points: number;
  evidence: string | null;
  createdAt: number;
}

/** Membro do time como o backend devolve em GET /v1/team. */
export interface TeamMemberInfo {
  accountId: string;
  role: 'owner' | 'member';
  name: string | null;
  email: string | null;
  avatarUrl: string | null;
}

export interface InviteInfo {
  codePrefix: string;
  usedCount: number;
  maxUses: number;
  expiresAt: string;
}

export interface TeamInfo {
  team: { id: string; name: string; role: 'owner' | 'member' } | null;
  members?: TeamMemberInfo[];
  seats?: { used: number; total: number };
  overLimit?: boolean;
  status?: string;
  invites?: InviteInfo[];
}

export interface CheckoutRequest {
  plan: 'pro';
}
