import { useEffect } from 'react';
import { create } from 'zustand';
import type {
  ProviderQuotaEntry,
  QuotaFleetSnapshot,
} from '../../shared/quota-types';
import { QUOTA_HIGH_USAGE_THRESHOLD } from '../../shared/quota-types';

/**
 * Renderer mirror of quota-service fleet snapshots.
 */

export const EMPTY_QUOTA_SNAPSHOT: QuotaFleetSnapshot = {
  updatedAt: 0,
  entries: [],
  worstUsedRatio: null,
  highUsageCount: 0,
  unknownCount: 0,
};

interface QuotaStore {
  snapshot: QuotaFleetSnapshot;
  hydrate(): Promise<void>;
  refresh(): Promise<void>;
  receive(snapshot: QuotaFleetSnapshot): void;
  reset(): void;
}

function quotaApi() {
  return window.nexus?.quota;
}

export const useQuotaStore = create<QuotaStore>((set) => ({
  snapshot: EMPTY_QUOTA_SNAPSHOT,

  hydrate: async () => {
    const api = quotaApi();
    if (!api) return;
    try {
      const snapshot = await api.snapshot();
      set({ snapshot });
    } catch (err) {
      console.warn('[quota] hydrate failed:', err);
    }
  },

  refresh: async () => {
    const api = quotaApi();
    if (!api) return;
    try {
      const snapshot = await api.refresh();
      set({ snapshot });
    } catch (err) {
      console.warn('[quota] refresh failed:', err);
    }
  },

  receive: (snapshot) => set({ snapshot }),
  reset: () => set({ snapshot: EMPTY_QUOTA_SNAPSHOT }),
}));

export function useQuotaSync(): void {
  const hydrate = useQuotaStore((s) => s.hydrate);
  useEffect(() => {
    void hydrate();
  }, [hydrate]);

  useEffect(() => {
    const api = quotaApi();
    if (!api?.onChanged) return;
    return api.onChanged((snapshot) => {
      useQuotaStore.getState().receive(snapshot);
    });
  }, []);
}

export function entryForAccount(
  snapshot: QuotaFleetSnapshot,
  adapterId: string,
  accountId?: string,
): ProviderQuotaEntry | undefined {
  if (accountId) {
    const hit = snapshot.entries.find(
      (e) => e.adapterId === adapterId && e.accountId === accountId,
    );
    if (hit) return hit;
  }
  return (
    snapshot.entries.find(
      (e) => e.adapterId === adapterId && e.accountId === undefined,
    ) ?? snapshot.entries.find((e) => e.adapterId === adapterId)
  );
}

export function formatQuotaRatio(ratio: number | null): string {
  if (ratio === null) return '—';
  return `${Math.round(ratio * 100)}%`;
}

export function isEntryHighUsage(
  entry: ProviderQuotaEntry,
  threshold = QUOTA_HIGH_USAGE_THRESHOLD,
): boolean {
  if (entry.onCooldown) return true;
  let worst: number | null = null;
  for (const w of entry.windows) {
    if (w.usedRatio === null) continue;
    if (worst === null || w.usedRatio > worst) worst = w.usedRatio;
  }
  return worst !== null && worst >= threshold;
}
