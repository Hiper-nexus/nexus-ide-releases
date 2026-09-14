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

export type QuotaLoadStatus = 'idle' | 'loading' | 'ready' | 'error';

interface QuotaStore {
  snapshot: QuotaFleetSnapshot;
  status: QuotaLoadStatus;
  error: string | null;
  hydrate(): Promise<void>;
  refresh(opts?: { silent?: boolean }): Promise<void>;
  receive(snapshot: QuotaFleetSnapshot): void;
  reset(): void;
}

/** Shared in-flight hydrate so boot + panel open do not race/no-op. */
let hydrateInFlight: Promise<void> | null = null;

function quotaApi() {
  return window.nexus?.quota;
}

async function fetchSnapshot(
  mode: 'hydrate' | 'refresh',
): Promise<QuotaFleetSnapshot> {
  const api = quotaApi();
  if (!api) {
    throw new Error(
      'API de cotas indisponível neste build — reinicia o Nexus (npm start).',
    );
  }
  if (mode === 'refresh' && typeof api.refresh === 'function') {
    return api.refresh();
  }
  if (typeof api.snapshot !== 'function') {
    throw new Error('API de cotas incompleta (snapshot em falta).');
  }
  return api.snapshot();
}

export const useQuotaStore = create<QuotaStore>((set, get) => ({
  snapshot: EMPTY_QUOTA_SNAPSHOT,
  status: 'idle',
  error: null,

  hydrate: async () => {
    // Coalesce concurrent hydrates (boot + panel open) onto one in-flight
    // request instead of silently no-op'ing the second caller.
    if (get().status === 'loading' && hydrateInFlight) {
      await hydrateInFlight;
      return;
    }
    set({ status: 'loading', error: null });
    hydrateInFlight = (async () => {
      try {
        // Prefer force refresh so multi-provider probes always re-run when
        // the panel opens (avoids stuck empty cache after partial failures).
        const snapshot = await fetchSnapshot('refresh');
        set({ snapshot, status: 'ready', error: null });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.warn('[quota] hydrate failed:', err);
        set({ status: 'error', error: message });
      } finally {
        hydrateInFlight = null;
      }
    })();
    await hydrateInFlight;
  },

  refresh: async (opts) => {
    // Silent refreshes (background poll) keep the current snapshot on error
    // and never flash "Consultando…" over live data.
    const silent = opts?.silent === true;
    if (!silent) set({ status: 'loading', error: null });
    try {
      const snapshot = await fetchSnapshot('refresh');
      set({ snapshot, status: 'ready', error: null });
    } catch (err) {
      if (silent) {
        console.warn('[quota] background refresh failed:', err);
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      console.warn('[quota] refresh failed:', err);
      set({ status: 'error', error: message });
    }
  },

  receive: (snapshot) =>
    set({ snapshot, status: 'ready', error: null }),
  reset: () =>
    set({
      snapshot: EMPTY_QUOTA_SNAPSHOT,
      status: 'idle',
      error: null,
    }),
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

  // Background poll: without it, long sessions showed percentages from hours
  // ago (push only fired on limit hits). 5 min keeps providers happy while the
  // countdown labels tick per-minute via useMinuteTick.
  useEffect(() => {
    const timer = setInterval(() => {
      if (typeof document !== 'undefined' && document.hidden) return;
      void useQuotaStore.getState().refresh({ silent: true });
    }, 5 * 60_000);
    return () => clearInterval(timer);
  }, []);
}

export function entryForAccount(
  snapshot: QuotaFleetSnapshot,
  adapterId: string,
  accountId?: string,
): ProviderQuotaEntry | undefined {
  // A pinned pane must only ever see ITS account's quota. Falling through to
  // the native CLI row (or any other account) shows a different credential's
  // telemetry — a lie, not a fallback. Unpinned panes use the native row.
  if (accountId) {
    return snapshot.entries.find(
      (e) => e.adapterId === adapterId && e.accountId === accountId,
    );
  }
  return snapshot.entries.find(
    (e) => e.adapterId === adapterId && e.accountId === undefined,
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
  let worst: number | null = null;
  for (const w of entry.windows) {
    if (w.usedRatio === null) continue;
    if (worst === null || w.usedRatio > worst) worst = w.usedRatio;
  }
  return worst !== null && worst >= threshold;
}
