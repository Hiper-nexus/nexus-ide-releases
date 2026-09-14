/**
 * Provider account quota windows (session / hours / weekly) — distinct from
 * project token spend in usage-types. Never invent usedRatio without a source.
 */

import type { FailoverReasonKind } from './account-types';

export const QUOTA_CHANNELS = {
  snapshot: 'quota:snapshot',
  changed: 'quota:changed',
  refresh: 'quota:refresh',
} as const;

export type QuotaWindowKind =
  | 'session'
  | 'hours'
  | 'weekly'
  | 'monthly'
  | 'credits'
  | 'local';

export type QuotaSource =
  | 'provider-api'
  | 'transcript-inferred'
  | 'limit-hit'
  | 'local-tokens'
  | 'cooldown'
  | 'unknown';

export type QuotaConfidence = 'high' | 'medium' | 'low';

export interface QuotaWindow {
  kind: QuotaWindowKind;
  /** Short UI label: "Sessão", "5 Horas", "Semanal". */
  label: string;
  /**
   * Fraction used 0..1. null = unknown (UI must NOT show 0%).
   */
  usedRatio: number | null;
  /** Epoch ms when this window resets, if known. */
  resetsAt?: number;
  remainingLabel?: string;
  source: QuotaSource;
  confidence: QuotaConfidence;
}

export interface ProviderQuotaEntry {
  /** Stable list key: adapterId or adapterId:accountId */
  id: string;
  adapterId: string;
  /** Declared API provider supplying quota; adapterId remains the owner of the row. */
  usageProviderId?: string;
  accountId?: string;
  /** True when this account is currently active for the adapter */
  active?: boolean;
  /** Display name (CLI label or account label). */
  label: string;
  /** Provider binary detected / online enough to care. */
  installed: boolean;
  /** Account on cooldown after limit hit. */
  onCooldown: boolean;
  /** Why spawning is paused. Auth/transient cooldowns are not quota usage. */
  cooldownKind?: FailoverReasonKind;
  cooldownUntil?: number;
  windows: QuotaWindow[];
  updatedAt: number;
}

export interface QuotaFleetSnapshot {
  updatedAt: number;
  entries: ProviderQuotaEntry[];
  /** Worst usedRatio among known windows (null if none known). */
  worstUsedRatio: number | null;
  /** Count of entries with any known window ≥ threshold. */
  highUsageCount: number;
  /** Entries with only unknown windows. */
  unknownCount: number;
}

export const QUOTA_HIGH_USAGE_THRESHOLD = 0.8;
