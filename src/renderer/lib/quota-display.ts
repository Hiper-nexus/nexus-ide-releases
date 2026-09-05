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

export function shortWindowsLine(entry: ProviderQuotaEntry): string {
  const parts = entry.windows.slice(0, 3).map((w) => {
    const d = windowDisplay(w);
    const reset = w.remainingLabel ? ` · ${w.remainingLabel}` : '';
    return `${w.label} ${d.percentLabel}${reset}`;
  });
  return parts.join(' · ');
}

export function prioritizeReportedQuotas(entries: readonly ProviderQuotaEntry[]): ProviderQuotaEntry[] {
  const hasReportedQuota = (entry: ProviderQuotaEntry) => entry.windows.some(window => knownRatio(window.usedRatio));
  return [...entries].sort((a, b) => Number(hasReportedQuota(b)) - Number(hasReportedQuota(a)));
}
