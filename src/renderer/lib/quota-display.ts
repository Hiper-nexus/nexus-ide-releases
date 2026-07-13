/**
 * Pure UI helpers for quota fleet display (tests drive these, not mocks).
 */

import type {
  ProviderQuotaEntry,
  QuotaFleetSnapshot,
  QuotaWindow,
} from '../../shared/quota-types';
import { QUOTA_HIGH_USAGE_THRESHOLD } from '../../shared/quota-types';

export function windowDisplay(w: QuotaWindow): {
  percentLabel: string;
  tone: 'ok' | 'warn' | 'danger' | 'unknown';
  barRatio: number;
} {
  if (w.usedRatio === null) {
    return { percentLabel: '—', tone: 'unknown', barRatio: 0 };
  }
  const pct = Math.round(w.usedRatio * 100);
  const tone =
    w.usedRatio >= 0.8 ? 'danger' : w.usedRatio >= 0.5 ? 'warn' : 'ok';
  return { percentLabel: `${pct}%`, tone, barRatio: w.usedRatio };
}

/** Structured chip copy for a single-line bar pill (never multi-line). */
export function chipParts(
  snapshot: QuotaFleetSnapshot,
): { value: string } | null {
  if (snapshot.entries.length === 0) return null;
  if (snapshot.worstUsedRatio === null) {
    if (snapshot.unknownCount > 0) return { value: '—' };
    return null;
  }
  if (snapshot.highUsageCount > 1) {
    return { value: `${snapshot.highUsageCount} no limite` };
  }
  return { value: `${Math.round(snapshot.worstUsedRatio * 100)}%` };
}

export function chipLabel(snapshot: QuotaFleetSnapshot): string | null {
  const parts = chipParts(snapshot);
  if (!parts) return null;
  return `cota · ${parts.value}`;
}

export function chipTone(
  snapshot: QuotaFleetSnapshot,
): 'ok' | 'warn' | 'danger' | 'unknown' {
  if (snapshot.worstUsedRatio === null) return 'unknown';
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
