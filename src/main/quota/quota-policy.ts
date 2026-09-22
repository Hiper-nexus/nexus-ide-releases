/**
 * Fleet-level quota policy: worst ratio, high-usage flags, spawn warnings,
 * ranking/failover weights. Pure.
 */

import {
  QUOTA_HIGH_USAGE_THRESHOLD,
  type ProviderQuotaEntry,
  type QuotaFleetSnapshot,
  type QuotaWindow,
} from '../../shared/quota-types';

export function windowUsedRatio(w: QuotaWindow): number | null {
  return w.usedRatio;
}

export function entryWorstRatio(entry: ProviderQuotaEntry): number | null {
  let worst: number | null = null;
  for (const w of entry.windows) {
    if (w.usedRatio === null) continue;
    if (worst === null || w.usedRatio > worst) worst = w.usedRatio;
  }
  if (
    entry.onCooldown &&
    (entry.cooldownKind === 'quota' ||
      entry.cooldownKind === 'rate-limit')
  ) {
    return 1;
  }
  return worst;
}

/**
 * Worst ratio for DISPLAY (chip, cockpit bars, fleet counters). Only real
 * telemetry counts: a cooldown/limit-hit must never paint a fake 100% over a
 * fresh provider reading (e.g. account paused with weekly 54% reported).
 */
export function entryDisplayWorstRatio(
  entry: ProviderQuotaEntry,
): number | null {
  let worst: number | null = null;
  for (const w of entry.windows) {
    if (w.usedRatio === null) continue;
    if (worst === null || w.usedRatio > worst) worst = w.usedRatio;
  }
  return worst;
}

export function isHighUsage(
  entry: ProviderQuotaEntry,
  threshold = QUOTA_HIGH_USAGE_THRESHOLD,
): boolean {
  const worst = entryWorstRatio(entry);
  return worst !== null && worst >= threshold;
}

export function buildFleetSnapshot(
  entries: readonly ProviderQuotaEntry[],
  now = Date.now(),
  threshold = QUOTA_HIGH_USAGE_THRESHOLD,
): QuotaFleetSnapshot {
  let worstUsedRatio: number | null = null;
  let highUsageCount = 0;
  let unknownCount = 0;
  for (const e of entries) {
    // Display counters come from real telemetry only — cooldowns surface via
    // entry.onCooldown, never as a fabricated 100% in the fleet worst.
    const w = entryDisplayWorstRatio(e);
    if (w === null) {
      const allUnknown = e.windows.every((x) => x.usedRatio === null);
      if (allUnknown) unknownCount += 1;
    } else {
      if (worstUsedRatio === null || w > worstUsedRatio) worstUsedRatio = w;
      if (w >= threshold) highUsageCount += 1;
    }
  }
  // Dólares: só preço de lista já mapeado. Plano detectado sem preço
  // (Ultra sem 5×/20×, Team, Enterprise) conta em `detected` e não inventa
  // valor. `connected` é a frota inteira — o cartão não pode dizer que duas
  // assinaturas são todas as contas ligadas.
  let monthlyUsd = 0;
  let detected = 0;
  let priced = 0;
  let undetected = 0;
  for (const e of entries) {
    if (e.plan) {
      detected += 1;
      if (typeof e.plan.monthlyUsd === 'number') {
        monthlyUsd += e.plan.monthlyUsd;
        priced += 1;
      }
    } else if (e.planEligible) {
      undetected += 1;
    }
  }

  return {
    updatedAt: now,
    entries: [...entries],
    worstUsedRatio,
    highUsageCount,
    unknownCount,
    plans:
      detected > 0 || undetected > 0 || entries.length > 0
        ? { monthlyUsd, detected, priced, connected: entries.length, undetected }
        : undefined,
  };
}

/** 0..1 availability score for ranking/failover (1 = fully free). */
export function quotaAvailabilityScore(entry: ProviderQuotaEntry): number {
  if (entry.onCooldown) return 0;
  const worst = entryWorstRatio(entry);
  if (worst === null) return 0.55; // unknown: neutral-slightly cautious
  return clamp01(1 - worst);
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

export function spawnWarningForAccount(
  entry: ProviderQuotaEntry | undefined,
  threshold = QUOTA_HIGH_USAGE_THRESHOLD,
): string | null {
  if (!entry) return null;
  if (entry.onCooldown) {
    const until = entry.cooldownUntil
      ? new Date(entry.cooldownUntil).toLocaleTimeString()
      : 'em breve';
    return `Conta "${entry.label}" em cooldown até ${until}. Prefira outra conta.`;
  }
  const worst = entryWorstRatio(entry);
  if (worst !== null && worst >= threshold) {
    const pct = Math.round(worst * 100);
    return `Conta "${entry.label}" com cota alta (${pct}% na pior janela). Risco de limite.`;
  }
  return null;
}

/** Pick better of two accounts by remaining quota (higher score wins). */
export function preferAccountByQuota(
  a: ProviderQuotaEntry,
  b: ProviderQuotaEntry,
): ProviderQuotaEntry {
  return quotaAvailabilityScore(a) >= quotaAvailabilityScore(b) ? a : b;
}
