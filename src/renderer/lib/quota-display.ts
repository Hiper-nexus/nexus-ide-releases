/**
 * Pure UI helpers for quota fleet display (tests drive these, not mocks).
 */

import type {
  ProviderQuotaEntry,
  QuotaFleetSnapshot,
  QuotaWindow,
} from '../../shared/quota-types';
import { QUOTA_HIGH_USAGE_THRESHOLD } from '../../shared/quota-types';

const percentageNumber = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 1 });
function knownRatio(value: number | null): value is number {
  return value !== null && Number.isFinite(value) && value >= 0 && value <= 1;
}
function percentLabel(ratio: number): string {
  const value = ratio * 100;
  if (value > 0 && value < 0.1) return '<0,1%';
  if (value > 99.9 && value < 100) return '>99,9%';
  return `${percentageNumber.format(value)}%`;
}

/**
 * Live countdown to a reset epoch. Rendered labels must be recomputed from
 * resetsAt on each paint — the stored remainingLabel was frozen at fetch time
 * and goes stale between refreshes (no polling on the old pipeline).
 */
export function formatResetCountdown(
  resetsAt: number | undefined,
  now = Date.now(),
): string | null {
  if (resetsAt === undefined || !Number.isFinite(resetsAt)) return null;
  const left = Math.max(0, resetsAt - now);
  const mins = Math.round(left / 60_000);
  if (mins < 60) return `${Math.max(1, mins)}min`;
  const hours = Math.floor(mins / 60);
  const rem = mins % 60;
  if (hours < 48) return rem > 0 ? `${hours}h${rem}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  const h = hours % 24;
  return h > 0 ? `${days}d${h}h` : `${days}d`;
}

export function windowDisplay(w: QuotaWindow): {
  percentLabel: string;
  tone: 'ok' | 'warn' | 'danger' | 'unknown';
  barRatio: number;
} {
  if (!knownRatio(w.usedRatio)) {
    return { percentLabel: '—', tone: 'unknown', barRatio: 0 };
  }
  const tone =
    w.usedRatio >= 0.8 ? 'danger' : w.usedRatio >= 0.5 ? 'warn' : 'ok';
  return { percentLabel: percentLabel(w.usedRatio), tone, barRatio: w.usedRatio };
}

/** Structured chip copy for a single-line bar pill (never multi-line). */
export function chipParts(
  snapshot: QuotaFleetSnapshot,
): { value: string } | null {
  if (snapshot.entries.length === 0) return null;
  if (!knownRatio(snapshot.worstUsedRatio)) {
    if (snapshot.unknownCount > 0) return { value: '—' };
    return null;
  }
  if (snapshot.highUsageCount > 1) {
    return { value: `${snapshot.highUsageCount} com uso elevado` };
  }
  return { value: percentLabel(snapshot.worstUsedRatio) };
}

export function chipLabel(snapshot: QuotaFleetSnapshot): string | null {
  const parts = chipParts(snapshot);
  if (!parts) return null;
  return `cota · ${parts.value}`;
}

export function chipTone(
  snapshot: QuotaFleetSnapshot,
): 'ok' | 'warn' | 'danger' | 'unknown' {
  if (!knownRatio(snapshot.worstUsedRatio)) return 'unknown';
  if (snapshot.worstUsedRatio >= QUOTA_HIGH_USAGE_THRESHOLD) return 'danger';
  if (snapshot.worstUsedRatio >= 0.5) return 'warn';
  return 'ok';
}

export function shortWindowsLine(entry: ProviderQuotaEntry, now = Date.now()): string {
  const parts = entry.windows.slice(0, 3).map((w) => {
    const d = windowDisplay(w);
    // Prefer a live countdown off resetsAt; the stored label is fetch-time
    // frozen and only used when the provider gave no reset timestamp.
    const reset =
      formatResetCountdown(w.resetsAt, now) ?? w.remainingLabel ?? '';
    return `${w.label} ${d.percentLabel}${reset ? ` · ${reset}` : ''}`;
  });
  return parts.join(' · ');
}

export function prioritizeReportedQuotas(entries: readonly ProviderQuotaEntry[]): ProviderQuotaEntry[] {
  const hasReportedQuota = (entry: ProviderQuotaEntry) => entry.windows.some(window => knownRatio(window.usedRatio));
  return [...entries].sort((a, b) => Number(hasReportedQuota(b)) - Number(hasReportedQuota(a)));
}
